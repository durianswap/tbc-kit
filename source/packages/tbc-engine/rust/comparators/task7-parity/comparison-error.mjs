export class ComparisonError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ComparisonError";
    this.code = code;
  }
}
