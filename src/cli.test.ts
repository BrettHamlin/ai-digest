import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { generateDigestContent } from "./digest";

const execAsync = promisify(exec);

const runCLI = async (args: string = "") => {
  const cliPath = path.resolve(__dirname, "index.ts");
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

const runCLIProcess = async (
  args: string[] = [],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> => {
  const cliPath = path.resolve(__dirname, "index.ts");
  const tsNodeRegister = require.resolve("ts-node/register");
  const childEnv = { ...process.env, ...options.env };

  if (options.cwd && options.env?.INIT_CWD === undefined) {
    childEnv.INIT_CWD = options.cwd;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-r", tsNodeRegister, cliPath, ...args],
      {
        cwd: options.cwd,
        env: childEnv,
      }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code,
      });
    });
  });
};

const fileExists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

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

  it("should list --stdout in the help output", async () => {
    //harness:criterion=c-stdout-flag-registered
    const result = await runCLIProcess(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf-8")).toContain("--stdout");
  }, 10000);

  it("should write exactly digest content to stdout without creating codebase.md", async () => {
    //harness:criterion=c-stdout-writes-to-stdout,c-stdout-no-file-created,c-stdout-no-progress-logs-on-stdout,c-stdout-digest-content-only-on-stdout,c-stdout-preserves-content-bytes,c-stdout-silent-mode-used
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-test-")
    );
    const inputDir = path.join(tempRoot, "input");
    const cwdDir = path.join(tempRoot, "cwd");

    try {
      await fs.mkdir(inputDir);
      await fs.mkdir(cwdDir);
      await fs.writeFile(path.join(inputDir, "alpha.txt"), "alpha content");

      const { content } = await generateDigestContent({
        inputDirs: [inputDir],
        outputFilePath: null,
        silent: true,
      });
      const result = await runCLIProcess(["--stdout", "--input", inputDir], {
        cwd: cwdDir,
      });
      const stdoutText = result.stdout.toString("utf-8");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(stdoutText.length).toBeGreaterThan(0);
      expect(stdoutText).toContain("# alpha.txt");
      expect(stdoutText).toBe(content);
      expect(result.stdout.equals(Buffer.from(content))).toBe(true);
      expect(stdoutText).not.toMatch(
        /Scanning directory|Files aggregated successfully|Warning|^Ignore patterns from/m
      );
      await expect(fileExists(path.join(cwdDir, "codebase.md"))).resolves.toBe(
        false
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should not create an output file and should not exclude a matching input file in stdout mode", async () => {
    //harness:criterion=c-stdout-no-output-file-created,c-stdout-output-file-not-excluded-from-processing
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-output-test-")
    );
    const inputDir = path.join(tempRoot, "input");
    const cwdDir = path.join(tempRoot, "cwd");

    try {
      await fs.mkdir(inputDir);
      await fs.mkdir(cwdDir);
      await fs.writeFile(path.join(inputDir, "source.txt"), "source content");

      const noCreateResult = await runCLIProcess(
        ["--stdout", "--output", "custom.md", "--input", inputDir],
        { cwd: cwdDir }
      );

      expect(noCreateResult.code).toBe(0);
      await expect(fileExists(path.join(cwdDir, "custom.md"))).resolves.toBe(
        false
      );

      await fs.writeFile(
        path.join(inputDir, "custom.md"),
        "pre-existing digest target content"
      );

      const includeResult = await runCLIProcess(
        ["--stdout", "--output", "custom.md", "--input", inputDir],
        { cwd: inputDir }
      );
      const stdoutText = includeResult.stdout.toString("utf-8");

      expect(includeResult.code).toBe(0);
      expect(stdoutText).toContain("# custom.md");
      expect(stdoutText).toContain("pre-existing digest target content");
      await expect(fs.readFile(path.join(inputDir, "custom.md"), "utf-8"))
        .resolves.toBe("pre-existing digest target content");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should preserve exact stdout content when an output path matches an input file", async () => {
    //harness:criterion=c-stdout-digest-content-only-on-stdout,c-stdout-preserves-content-bytes,c-stdout-output-file-not-excluded-from-processing
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-output-exact-test-")
    );

    try {
      await fs.writeFile(path.join(tempRoot, "custom.md"), "keep me");
      await fs.writeFile(path.join(tempRoot, "source.txt"), "source content");

      const { content } = await generateDigestContent({
        inputDirs: [tempRoot],
        outputFilePath: null,
        silent: true,
      });

      const result = await runCLIProcess(
        ["--stdout", "--output", "custom.md", "--input", tempRoot],
        { cwd: tempRoot }
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.equals(Buffer.from(content))).toBe(true);
      expect(result.stdout.toString("utf-8")).toContain("# custom.md");
      expect(result.stdout.toString("utf-8")).toContain("keep me");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should write stdout mode errors only to stderr", async () => {
    //harness:criterion=c-stdout-errors-go-to-stderr
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-error-test-")
    );

    try {
      const result = await runCLIProcess(
        ["--stdout", "--input", path.join(tempRoot, "missing")],
        { cwd: tempRoot }
      );

      expect(result.code).not.toBe(0);
      expect(result.stdout.toString("utf-8")).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/error|ENOENT|missing|no such/i);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 10000);

  it("should reject combining --stdout and --watch before writing digest content", async () => {
    //harness:criterion=c-stdout-watch-rejected-nonzero-exit,c-stdout-watch-rejected-stderr-message,c-stdout-watch-no-digest-on-stdout
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-watch-test-")
    );
    const inputDir = path.join(tempRoot, "input");

    try {
      await fs.mkdir(inputDir);
      await fs.writeFile(path.join(inputDir, "watch.txt"), "watch content");

      const result = await runCLIProcess(
        ["--stdout", "--watch", "--input", inputDir],
        { cwd: tempRoot }
      );

      expect(result.code).not.toBe(0);
      expect(result.stdout.toString("utf-8")).toBe("");
      expect(result.stderr).toMatch(
        /--stdout.*--watch|--watch.*--stdout|cannot be combined/i
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 10000);

  it("should honor ignore and default-ignore options in stdout mode", async () => {
    //harness:criterion=c-stdout-honors-ignore-file,c-stdout-honors-no-default-ignores
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-ignore-test-")
    );

    try {
      await fs.writeFile(path.join(tempRoot, "keep.txt"), "public content");
      await fs.writeFile(path.join(tempRoot, "secret.txt"), "secret content");
      await fs.writeFile(path.join(tempRoot, ".env"), "DEFAULT_IGNORED=yes");
      await fs.writeFile(
        path.join(tempRoot, ".customignore"),
        "secret.txt\n.customignore\n"
      );

      const ignoredResult = await runCLIProcess(
        ["--stdout", "--ignore-file", ".customignore", "--input", tempRoot],
        { cwd: tempRoot }
      );
      const ignoredStdout = ignoredResult.stdout.toString("utf-8");

      expect(ignoredResult.code).toBe(0);
      expect(ignoredStdout).toContain("public content");
      expect(ignoredStdout).not.toContain("Ignore patterns from");
      expect(ignoredStdout).not.toContain("# secret.txt");
      expect(ignoredStdout).not.toContain("secret content");

      const defaultIgnoredResult = await runCLIProcess(
        ["--stdout", "--input", tempRoot],
        { cwd: tempRoot }
      );
      expect(defaultIgnoredResult.stdout.toString("utf-8")).not.toContain(
        "DEFAULT_IGNORED=yes"
      );

      const noDefaultIgnoresResult = await runCLIProcess(
        ["--stdout", "--no-default-ignores", "--input", tempRoot],
        { cwd: tempRoot }
      );
      const noDefaultStdout = noDefaultIgnoresResult.stdout.toString("utf-8");

      expect(noDefaultIgnoresResult.code).toBe(0);
      expect(noDefaultStdout).toContain("# .env");
      expect(noDefaultStdout).toContain("DEFAULT_IGNORED=yes");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should honor minify-file and whitespace-removal options in stdout mode", async () => {
    //harness:criterion=c-stdout-honors-minify-file,c-stdout-honors-whitespace-removal
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-transform-test-")
    );

    try {
      await fs.writeFile(
        path.join(tempRoot, "multi.js"),
        "function expanded() {\n    return \"full content\";\n}\n"
      );
      await fs.writeFile(
        path.join(tempRoot, "spacey.js"),
        "const value =    1;\n\nconsole.log( value );\n"
      );

      const plainResult = await runCLIProcess(
        ["--stdout", "--minify-file", ".missingminify", "--input", tempRoot],
        { cwd: tempRoot }
      );
      const plainStdout = plainResult.stdout.toString("utf-8");

      await fs.writeFile(
        path.join(tempRoot, ".customminify"),
        "multi.js\n.customminify\n"
      );

      const minifiedResult = await runCLIProcess(
        ["--stdout", "--minify-file", ".customminify", "--input", tempRoot],
        { cwd: tempRoot }
      );
      const minifiedStdout = minifiedResult.stdout.toString("utf-8");

      expect(minifiedResult.code).toBe(0);
      expect(minifiedStdout).not.toBe(plainStdout);
      expect(minifiedStdout).toContain("# multi.js");
      expect(minifiedStdout).toContain("This is a minified file of type: .js");
      expect(minifiedStdout).not.toContain('return "full content";');

      const whitespaceResult = await runCLIProcess(
        [
          "--stdout",
          "--whitespace-removal",
          "--minify-file",
          ".missingminify",
          "--input",
          tempRoot,
        ],
        { cwd: tempRoot }
      );
      const whitespaceStdout = whitespaceResult.stdout.toString("utf-8");

      expect(plainStdout).toContain(
        "const value =    1;\n\nconsole.log( value );"
      );
      expect(whitespaceResult.code).toBe(0);
      expect(whitespaceStdout).toContain(
        "const value = 1; console.log( value );"
      );
      expect(whitespaceStdout).not.toContain(
        "const value =    1;\n\nconsole.log( value );"
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should preserve normal file-output behavior when --stdout is omitted", async () => {
    //harness:criterion=c-no-stdout-default-behavior-unchanged
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-no-stdout-test-")
    );
    const inputDir = path.join(tempRoot, "input");
    const cwdDir = path.join(tempRoot, "cwd");

    try {
      await fs.mkdir(inputDir);
      await fs.mkdir(cwdDir);
      await fs.writeFile(path.join(inputDir, "plain.txt"), "plain content");

      const result = await runCLIProcess(["--input", inputDir], {
        cwd: cwdDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf-8")).toMatch(
        /Files aggregated successfully/
      );
      await expect(fileExists(path.join(cwdDir, "codebase.md"))).resolves.toBe(
        true
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should keep watch mode usable when --stdout is omitted", async () => {
    //harness:criterion=c-no-stdout-watch-still-works
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-no-stdout-watch-test-")
    );
    const inputDir = path.join(tempRoot, "input");

    try {
      await fs.mkdir(inputDir);
      await fs.writeFile(path.join(inputDir, "watch.txt"), "watch content");

      const result = await runCLIProcess(["--watch", "--input", inputDir], {
        cwd: tempRoot,
        env: { NODE_ENV: "test" },
      });

      expect(result.code).toBe(0);
      expect(result.stdout.toString("utf-8")).toContain("Watch mode enabled");
      expect(result.stderr).not.toMatch(
        /--stdout.*--watch|--watch.*--stdout|cannot be combined/i
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should document --stdout in README options and examples", async () => {
    //harness:criterion=c-readme-documents-stdout-flag,c-readme-documents-watch-incompatibility,c-readme-includes-usage-example
    const readme = await fs.readFile(
      path.resolve(__dirname, "..", "README.md"),
      "utf-8"
    );

    expect(readme).toMatch(/--stdout.{0,200}stdout/si);
    expect(readme).toMatch(
      /--stdout.*--watch|--watch.*--stdout|cannot be combined/i
    );
    expect(readme).toMatch(/(?:npx\s+)?ai-digest\s+--stdout[\s|>]/);
  });
});
