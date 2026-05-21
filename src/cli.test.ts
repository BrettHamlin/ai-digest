import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";

const execAsync = promisify(exec);

type CLIProcessResult = {
  code: number;
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
};

const cliPath = path.resolve(__dirname, "index.ts");
const tsNodePath = path.resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ts-node.cmd" : "ts-node",
);

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const runCLIProcess = async (
  args: string[] = [],
  cwd: string = process.cwd(),
): Promise<CLIProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(tsNodePath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, INIT_CWD: cwd },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      resolve({
        code: code ?? -1,
        stdout: stdoutBuffer.toString("utf-8"),
        stdoutBuffer,
        stderr: stderrBuffer.toString("utf-8"),
      });
    });
  });

const createTempFixture = async (
  files: Record<string, string>,
): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-digest-stdout-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(tempDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  return tempDir;
};

const pathExists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

const execInFixture = (
  command: string,
  cwd: string,
): ReturnType<typeof execAsync> =>
  execAsync(command, {
    cwd,
    env: { ...process.env, INIT_CWD: cwd },
  });

const runCLI = async (args: string = "") => {
  return execAsync(`ts-node ${cliPath} ${args}`);
};

// New helper to run CLI with specific environment variables
const runCLIWithEnv = async (
  args: string = "",
  env: Record<string, string> = {}
) => {
  const cliPath = path.resolve(__dirname, "index.ts");
  const envVars = Object.entries(env)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  return execAsync(`${envVars} ts-node ${cliPath} ${args}`);
};

describe("AI Digest CLI", () => {
  afterAll(async () => {
    // Remove the created .md files after all tests complete
    await fs
      .unlink(path.resolve(__dirname, "..", "codebase.md"))
      .catch(() => {});
    await fs
      .unlink(path.resolve(__dirname, "..", "custom_output.md"))
      .catch(() => {});
  });

  it("should generate codebase.md by default", async () => {
    const { stdout } = await runCLI();
    expect(stdout).toMatch(/Files aggregated successfully into .*codebase\.md/);
  }, 10000);

  it("should respect custom output file", async () => {
    const { stdout } = await runCLI("-o custom_output.md");
    expect(stdout).toMatch(
      /Files aggregated successfully into .*custom_output\.md/
    );
  }, 10000);

  it("should ignore files based on .aidigestignore", async () => {
    const { stdout } = await runCLI();
    expect(stdout).toContain("Files ignored by .aidigestignore:");
  }, 10000);

  it("should remove whitespace when flag is set", async () => {
    const { stdout } = await runCLI("--whitespace-removal");
    expect(stdout).toContain("Whitespace removal enabled");
  }, 10000);

  it("should not remove whitespace for whitespace-dependent files", async () => {
    const { stdout } = await runCLI("--whitespace-removal");
    expect(stdout).toContain(
      "Whitespace removal enabled (except for whitespace-dependent languages)"
    );
  }, 10000);

  it("should disable default ignores when flag is set", async () => {
    const { stdout } = await runCLI("--no-default-ignores");
    expect(stdout).toContain("Default ignore patterns disabled");
  }, 10000);

  it("should include binary files with a note", async () => {
    const { stdout } = await runCLI();
    expect(stdout).toMatch(/Binary and SVG files included: \d+/);
  }, 10000);

  it("should show output files when flag is set", async () => {
    const { stdout } = await runCLI("--show-output-files");
    expect(stdout).toContain("Files included in the output:");
  }, 10000);

  it("should include SVG file with correct type in codebase.md", async () => {
    await runCLI();
    const codebasePath = path.resolve(__dirname, "..", "codebase.md");
    const content = await fs.readFile(codebasePath, "utf-8");

    expect(content).toContain("# test/smiley.svg");
    expect(content).toContain("This is a file of the type: SVG Image");
  }, 10000);

  it("should respect the --input flag", async () => {
    // Create a temporary directory
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-digest-test-"));

    try {
      // Create some test files in the temporary directory
      await fs.writeFile(path.join(tempDir, "test1.txt"), "Test content 1");
      await fs.writeFile(
        path.join(tempDir, "test2.js"),
        "console.log(\"Test content 2\");"
      );

      // Create a subdirectory with a file
      const subDir = path.join(tempDir, "subdir");
      await fs.mkdir(subDir);
      await fs.writeFile(
        path.join(subDir, "test3.py"),
        "print(\"Test content 3\")"
      );

      // Run the CLI with the --input flag
      const { stdout } = await runCLI(`--input ${tempDir} --show-output-files`);

      // Check if the output contains only the files we created
      expect(stdout).toContain("test1.txt");
      expect(stdout).toContain("test2.js");
      expect(stdout).toContain("subdir/test3.py");

      // Check if the output doesn't contain files from the project directory
      expect(stdout).not.toContain("package.json");
      expect(stdout).not.toContain("tsconfig.json");

      // Read the generated codebase.md file
      const codebasePath = path.resolve(process.cwd(), "codebase.md");
      const content = await fs.readFile(codebasePath, "utf-8");

      // Verify the content of codebase.md
      expect(content).toContain("# test1.txt");
      expect(content).toContain("Test content 1");
      expect(content).toContain("# test2.js");
      expect(content).toContain("console.log(\"Test content 2\");");
      expect(content).toContain("# subdir/test3.py");
      expect(content).toContain("print(\"Test content 3\")");
    } finally {
      // Clean up: remove the temporary directory and its contents
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000); // Increased timeout to 15 seconds due to file operations

  it("should respect custom ignore file", async () => {
    // Create a temporary directory
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-custom-ignore-test-")
    );

    try {
      // Create some test files in the temporary directory
      await fs.writeFile(
        path.join(tempDir, "include.txt"),
        "This file should be included"
      );
      await fs.writeFile(
        path.join(tempDir, "exclude.js"),
        "This file should be excluded"
      );

      // Create a custom ignore file
      await fs.writeFile(path.join(tempDir, "custom.ignore"), "*.js");

      // Run the CLI with the custom ignore file
      const { stdout } = await runCLI(
        `--input ${tempDir} --ignore-file custom.ignore --show-output-files`
      );

      // Check if the output contains only the files we want to include
      expect(stdout).toContain("include.txt");
      expect(stdout).not.toContain("exclude.js");

      // Check if the custom ignore patterns are mentioned
      expect(stdout).toContain("Ignore patterns from custom.ignore:");
      expect(stdout).toContain("  - *.js");

      // Read the generated codebase.md file
      const codebasePath = path.resolve(process.cwd(), "codebase.md");
      const content = await fs.readFile(codebasePath, "utf-8");

      // Verify the content of codebase.md
      expect(content).toContain("# include.txt");
      expect(content).toContain("This file should be included");
      expect(content).not.toContain("# exclude.js");
      expect(content).not.toContain("This file should be excluded");
    } finally {
      // Clean up: remove the temporary directory and its contents
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should sort files in natural path order", async () => {
    // Create a temporary directory
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-sort-test-")
    );

    try {
      // Create test files and directories
      await fs.mkdir(path.join(tempDir, "01-first"));
      await fs.mkdir(path.join(tempDir, "02-second"));
      await fs.mkdir(path.join(tempDir, "10-tenth"));

      await fs.writeFile(
        path.join(tempDir, "01-first", "01-file.txt"),
        "First file"
      );
      await fs.writeFile(
        path.join(tempDir, "01-first", "02-file.txt"),
        "Second file"
      );
      await fs.writeFile(
        path.join(tempDir, "02-second", "01-file.txt"),
        "Third file"
      );
      await fs.writeFile(
        path.join(tempDir, "10-tenth", "01-file.txt"),
        "Fourth file"
      );
      await fs.writeFile(path.join(tempDir, "root-file.txt"), "Root file");

      // Run the CLI with the test directory
      await runCLI(`--input ${tempDir}`);

      // Read the generated codebase.md file
      const codebasePath = path.resolve(process.cwd(), "codebase.md");
      const content = await fs.readFile(codebasePath, "utf-8");

      // Define the expected order of file headers
      const expectedOrder = [
        "# 01-first/01-file.txt",
        "# 01-first/02-file.txt",
        "# 02-second/01-file.txt",
        "# 10-tenth/01-file.txt",
        "# root-file.txt",
      ];

      // Check if all expected headers are present and in the correct order
      let lastIndex = -1;
      for (const header of expectedOrder) {
        const currentIndex = content.indexOf(header);
        expect(currentIndex).toBeGreaterThan(lastIndex);
        lastIndex = currentIndex;
      }
    } finally {
      // Clean up: remove the temporary directory and its contents
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should recognize the --watch flag", async () => {
    try {
      // Run CLI with watch flag and NODE_ENV=test to exit early
      const { stdout } = await runCLIWithEnv("--watch", { NODE_ENV: "test" });

      // Verify watch mode was initialized but did not hang
      expect(stdout).toContain("Watch mode enabled");
      expect(stdout).toContain("Waiting for file changes");
    } catch (error) {
      // If there's any error, it should still have shown the watch messages
      fail(`Watch test failed: ${error}`);
    }
  }, 10000);

  // Test for multiple input directories
  it("should handle multiple input directories", async () => {
    // Create two temporary directories
    const tempDir1 = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-test-dir1-")
    );
    const tempDir2 = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-test-dir2-")
    );

    try {
      // Create test files in first directory
      await fs.writeFile(
        path.join(tempDir1, "dir1-file1.txt"),
        "Content from dir1"
      );
      await fs.writeFile(
        path.join(tempDir1, "common.txt"),
        "Common file in dir1"
      );

      // Create test files in second directory
      await fs.writeFile(
        path.join(tempDir2, "dir2-file1.txt"),
        "Content from dir2"
      );
      await fs.writeFile(
        path.join(tempDir2, "common.txt"),
        "Common file in dir2"
      );

      // Run CLI with multiple input directories
      const { stdout } = await runCLI(
        `--input ${tempDir1} ${tempDir2} --show-output-files`
      );

      // Verify output
      expect(stdout).toContain(`Scanning directory: ${tempDir1}`);
      expect(stdout).toContain(`Scanning directory: ${tempDir2}`);

      // Verify files from both directories are included
      expect(stdout).toContain(`${path.basename(tempDir1)}/dir1-file1.txt`);
      expect(stdout).toContain(`${path.basename(tempDir2)}/dir2-file1.txt`);
      expect(stdout).toContain(`${path.basename(tempDir1)}/common.txt`);
      expect(stdout).toContain(`${path.basename(tempDir2)}/common.txt`);

      // Read the generated codebase.md file
      const codebasePath = path.resolve(process.cwd(), "codebase.md");
      const content = await fs.readFile(codebasePath, "utf-8");

      // Verify content from both directories is included
      expect(content).toContain(`# ${path.basename(tempDir1)}/dir1-file1.txt`);
      expect(content).toContain("Content from dir1");
      expect(content).toContain(`# ${path.basename(tempDir2)}/dir2-file1.txt`);
      expect(content).toContain("Content from dir2");

      // Check common files are included with directory prefixes
      expect(content).toContain(`# ${path.basename(tempDir1)}/common.txt`);
      expect(content).toContain("Common file in dir1");
      expect(content).toContain(`# ${path.basename(tempDir2)}/common.txt`);
      expect(content).toContain("Common file in dir2");
    } finally {
      // Clean up the temporary directories
      await fs.rm(tempDir1, { recursive: true, force: true });
      await fs.rm(tempDir2, { recursive: true, force: true });
    }
  }, 15000);

  // New test for working directory behavior
  it("should respect INIT_CWD when different from process.cwd()", async () => {
    // Create a temporary directory structure
    const tempRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-wd-test-")
    );
    const subDir = path.join(tempRootDir, "subdir");
    await fs.mkdir(subDir);

    // Create test files
    await fs.writeFile(
      path.join(tempRootDir, "root-file.txt"),
      "Root file content"
    );

    try {
      // Run with INIT_CWD set to subdirectory but cwd unchanged
      const env = { INIT_CWD: subDir };

      // Use the tempRootDir as input to have files to process
      await runCLIWithEnv(`--input ${tempRootDir}`, env);

      // Verify the file was created in the subdirectory (INIT_CWD)
      const subDirOutputPath = path.join(subDir, "codebase.md");
      const fileExists = await fs
        .access(subDirOutputPath)
        .then(() => true)
        .catch(() => false);

      expect(fileExists).toBe(true);

      // Verify content includes the root file
      const content = await fs.readFile(subDirOutputPath, "utf-8");
      expect(content).toContain("root-file.txt");
      expect(content).toContain("Root file content");

      // Clean up the output file
      await fs.unlink(subDirOutputPath).catch(() => {});
    } finally {
      // Clean up the test directories
      await fs.rm(tempRootDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-flag-exists,c-stdout-writes-to-stdout,c-stdout-no-file-created,c-stdout-stderr-clean-on-success,c-stdout-no-progress-on-stdout
  it("writes only digest markdown to stdout without creating an output file", async () => {
    const tempDir = await createTempFixture({
      "sample.ts": "export const sample = 42;\n",
    });

    try {
      const result = await runCLIProcess(["--stdout"], tempDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdoutBuffer.length).toBeGreaterThan(0);
      expect(result.stdout).toMatch(/^#/m);
      expect(result.stdout).toContain("# sample.ts");
      expect(result.stdout).toContain("export const sample = 42;");
      expect(result.stdout).not.toMatch(
        /Processing|Generating|Written to|files processed|Summary|Files aggregated successfully|codebase\.md/i,
      );
      await expect(pathExists(path.join(tempDir, "codebase.md"))).resolves.toBe(
        false,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-no-file-created
  it("does not overwrite an existing default output file in stdout mode", async () => {
    const existingOutput = "existing digest content\n";
    const tempDir = await createTempFixture({
      "sample.ts": "export const replacement = true;\n",
      "codebase.md": existingOutput,
    });

    try {
      const result = await runCLIProcess(["--stdout"], tempDir);
      const codebasePath = path.join(tempDir, "codebase.md");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      await expect(fs.readFile(codebasePath, "utf-8")).resolves.toBe(
        existingOutput,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-watch-rejected,c-stdout-watch-error-on-stderr
  it("rejects stdout mode combined with watch mode on stderr only", async () => {
    const tempDir = await createTempFixture({
      "sample.ts": "export const sample = 42;\n",
    });

    try {
      const result = await runCLIProcess(["--stdout", "--watch"], tempDir);

      expect(result.code).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/cannot|incompatible|watch/i);
      expect(result.stdout.trim()).toBe("");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-errors-to-stderr,c-stdout-errors-not-on-stdout
  it("reports stdout mode generation errors on stderr only", async () => {
    const tempDir = await createTempFixture({
      "sample.ts": "export const sample = 42;\n",
    });
    const missingDir = path.join(tempDir, "missing");

    try {
      const result = await runCLIProcess(
        ["--stdout", "--input", missingDir],
        tempDir,
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/error|missing|no such file|ENOENT/i);
      expect(result.stdout.trim()).toBe("");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-ignore-patterns-respected
  it("respects ignore patterns when writing digest content to stdout", async () => {
    const tempDir = await createTempFixture({
      "include-me.ts": "export const includedMarker = true;\n",
      "exclude-me.ts": "export const excludedMarker = true;\n",
      ".aidigestignore": "exclude-me.ts\n",
    });

    try {
      const result = await runCLIProcess(["--stdout"], tempDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("# include-me.ts");
      expect(result.stdout).toContain("includedMarker");
      expect(result.stdout).not.toContain("exclude-me.ts");
      expect(result.stdout).not.toContain("excludedMarker");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-minify-file-respected
  it("respects minify-file patterns when writing digest content to stdout", async () => {
    const longTargetContent = Array.from(
      { length: 40 },
      (_, index) =>
        `// comment ${index}\n\nexport const fullContentMarker${index} = "${index}";\n`,
    ).join("\n");
    const tempDir = await createTempFixture({
      "target.ts": longTargetContent,
      "minify-patterns.txt": "target.ts\n",
    });

    try {
      const regular = await runCLIProcess(["--stdout"], tempDir);
      const minified = await runCLIProcess(
        ["--stdout", "--minify-file", "minify-patterns.txt"],
        tempDir,
      );

      expect(regular.code).toBe(0);
      expect(minified.code).toBe(0);
      expect(minified.stderr).toBe("");
      expect(regular.stdout).toContain("fullContentMarker0");
      expect(minified.stdout).toContain("# target.ts");
      expect(minified.stdout).toContain("This is a minified file");
      expect(minified.stdout).not.toContain("fullContentMarker0");
      expect(minified.stdoutBuffer.length).toBeLessThan(
        regular.stdoutBuffer.length,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-whitespace-removal-respected
  it("applies whitespace removal when writing digest content to stdout", async () => {
    const originalSource =
      "function test() {\n    const value    =    1;    \n\n    const other = 2;\n}\n";
    const tempDir = await createTempFixture({
      "whitespace.ts": originalSource,
    });

    try {
      const regular = await runCLIProcess(["--stdout"], tempDir);
      const stripped = await runCLIProcess(
        ["--stdout", "--whitespace-removal"],
        tempDir,
      );

      expect(regular.code).toBe(0);
      expect(stripped.code).toBe(0);
      expect(stripped.stderr).toBe("");
      expect(regular.stdout).toContain(originalSource);
      expect(stripped.stdout).toContain(
        "function test() { const value = 1; const other = 2; }",
      );
      expect(stripped.stdoutBuffer.length).toBeLessThan(
        regular.stdoutBuffer.length,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-digest-byte-preserved
  it("matches stdout digest bytes to the file-output digest bytes", async () => {
    const tempDir = await createTempFixture({
      "same.ts": "export const bytePreserved = true;\n",
      "nested/readme.md": "## Nested content\n",
    });
    const outputPath = path.join(tempDir, "digest-output.md");

    try {
      const stdoutResult = await runCLIProcess(["--stdout"], tempDir);
      const fileResult = await runCLIProcess(
        ["--output", outputPath],
        tempDir,
      );
      const fileBuffer = await fs.readFile(outputPath);

      expect(stdoutResult.code).toBe(0);
      expect(fileResult.code).toBe(0);
      expect(stdoutResult.stdoutBuffer.equals(fileBuffer)).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-stdout-pipeable
  it("provides stdout bytes that can be consumed by a pipe", async () => {
    const tempDir = await createTempFixture({
      "pipe.ts": "export const pipeable = true;\n",
    });
    const cliCommand = `${shellQuote(tsNodePath)} ${shellQuote(cliPath)}`;

    try {
      const direct = await runCLIProcess(["--stdout"], tempDir);
      const { stdout: pipedByteCount } = await execInFixture(
        `${cliCommand} --stdout | wc -c`,
        tempDir,
      );
      const { stdout: headingCount } = await execInFixture(
        `${cliCommand} --stdout | grep -c '^#'`,
        tempDir,
      );

      expect(direct.code).toBe(0);
      expect(direct.stdoutBuffer.length).toBeGreaterThan(0);
      expect(Number.parseInt(String(pipedByteCount).trim(), 10)).toBe(
        direct.stdoutBuffer.length,
      );
      expect(
        Number.parseInt(String(headingCount).trim(), 10),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  // harness:criterion=c-readme-stdout-documented
  it("documents the stdout flag in the README options table", async () => {
    const readme = await fs.readFile(
      path.resolve(__dirname, "..", "README.md"),
      "utf-8",
    );

    expect(readme.split(/\r?\n/)).toContainEqual(
      expect.stringMatching(/\|.*`--stdout`.*\|/),
    );
  });

  // harness:criterion=c-readme-watch-incompatibility-noted
  it("documents that stdout mode cannot be combined with watch mode", async () => {
    const readme = await fs.readFile(
      path.resolve(__dirname, "..", "README.md"),
      "utf-8",
    );
    const lines = readme.split(/\r?\n/);
    const stdoutWatchLine = lines.findIndex(
      (line) =>
        line.includes("--stdout") &&
        line.includes("--watch") &&
        /cannot|incompatible/i.test(line),
    );

    expect(stdoutWatchLine).toBeGreaterThanOrEqual(0);
  });

  // harness:criterion=c-readme-pipeline-example
  it("documents a stdout shell pipeline example", async () => {
    const readme = await fs.readFile(
      path.resolve(__dirname, "..", "README.md"),
      "utf-8",
    );

    expect(readme).toMatch(/--stdout.*\|/);
  });

  // harness:criterion=c-package-minor-version-bumped
  it("bumps package.json by one minor version with a zero patch", async () => {
    const packageJsonPath = path.resolve(__dirname, "..", "package.json");
    const currentPackage = JSON.parse(
      await fs.readFile(packageJsonPath, "utf-8"),
    );
    const { stdout: previousPackageJson } = await execAsync(
      "git show HEAD:package.json",
      { cwd: path.resolve(__dirname, "..") },
    );
    const previousPackage = JSON.parse(previousPackageJson);
    const [currentMajor, currentMinor, currentPatch] = currentPackage.version
      .split(".")
      .map(Number);
    const [previousMajor, previousMinor] = previousPackage.version
      .split(".")
      .map(Number);

    expect(currentMajor).toBe(previousMajor);
    expect(currentMinor).toBe(previousMinor + 1);
    expect(currentPatch).toBe(0);
  });
});
