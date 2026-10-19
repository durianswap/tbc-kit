import ts from "typescript";

// Build-time only. AJV embeds complete schemas even when generated code reads
// only an enum or the keys accepted by additionalProperties. Project those
// constant reads without changing validators, formats, errors or CSP behavior.
export function compactValidatorSchemas(source) {
  const ast = ts.createSourceFile("validators.ts", source, ts.ScriptTarget.Latest, true);
  const schemas = new Map();
  const ownPropertyFunctions = new Set();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (declaration.initializer.getText(ast) === "Object.prototype.hasOwnProperty") {
        ownPropertyFunctions.add(declaration.name.text);
      }
      if (!/^schema\d+$/.test(declaration.name.text) ||
          statement.declarationList.declarations.length !== 1) continue;
      try {
        schemas.set(declaration.name.text, {
          declaration, statement,
          value: JSON.parse(declaration.initializer.getText(ast)),
          reads: [], unsafe: false,
        });
      } catch { /* Non-JSON constants remain unchanged. */ }
    }
  }
  function visit(node) {
    if (ts.isIdentifier(node) && schemas.has(node.text)) {
      const schema = schemas.get(node.text);
      if (node === schema.declaration.name) return;
      let expression = node;
      const keys = [];
      while (ts.isPropertyAccessExpression(expression.parent) &&
             expression.parent.expression === expression) {
        expression = expression.parent;
        keys.push(expression.name.text);
      }
      const parent = expression.parent;
      if (!keys.length || ts.isElementAccessExpression(parent) ||
          ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent) ||
          ts.isPrefixUnaryExpression(parent) ||
          (ts.isBinaryExpression(parent) && parent.left === expression &&
           parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
           parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          (ts.isCallExpression(parent) && parent.expression === expression)) {
        schema.unsafe = true;
        return;
      }
      let value = schema.value;
      for (const key of keys) {
        if (value === null || typeof value !== "object" ||
            !Object.hasOwn(value, key)) { schema.unsafe = true; return; }
        value = value[key];
      }
      const keysOnly = ts.isCallExpression(parent) && parent.arguments.length === 2 &&
        parent.arguments[0] === expression && ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === "call" &&
        ownPropertyFunctions.has(parent.expression.expression.getText(ast));
      if (keysOnly && value && typeof value === "object" && !Array.isArray(value) &&
          !Object.hasOwn(value, "__proto__")) {
        value = Object.fromEntries(Object.keys(value).map(key => [key, true]));
      }
      schema.reads.push({ expression, key: `${keys.join(".")}:${keysOnly}`, value });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const edits = [], constants = [];
  for (const schema of schemas.values()) {
    if (schema.unsafe || !schema.reads.length) continue;
    const projections = new Map();
    for (const read of schema.reads) {
      if (!projections.has(read.key)) {
        const name = `twsSchemaProjection${constants.length}`;
        if (new RegExp(`\\b${name}\\b`).test(source)) throw new Error("Schema projection name collision");
        projections.set(read.key, name);
        constants.push(`const ${name} = ${JSON.stringify(read.value)};`);
      }
      edits.push({ start: read.expression.getStart(ast), end: read.expression.end,
        text: projections.get(read.key) });
    }
    edits.push({ start: schema.statement.getStart(ast), end: schema.statement.end, text: "" });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return constants.length ? `${constants.join("\n")}\n${source}` : source;
}
