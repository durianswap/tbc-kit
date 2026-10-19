import { execFileSync } from "node:child_process";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function git(repository, args, encoding) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

export function resolveGitHead(repository) {
  return git(repository, ["rev-parse", "HEAD"], "utf8").trim();
}

export function listGitTree(repository, commit, subtree) {
  return git(
    repository,
    ["ls-tree", "-r", "-z", "--name-only", commit, "--", subtree],
    "utf8",
  ).split("\0").filter(Boolean).sort();
}

export function readGitObject(repository, commit, repositoryPath) {
  return git(repository, ["show", `${commit}:${repositoryPath}`], null);
}
