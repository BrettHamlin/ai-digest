import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";

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

const runCLIProcess = (
  args: string[] = [],
  cwd: string = path.resolve(__dirname, ".."),
  env: Record<string, string> = {}
): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }> => {
  const cliPath = path.resolve(__dirname, "index.ts");
  const tsNodePath = require.resolve("ts-node/dist/bin.js");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsNodePath, cliPath, ...args], {
      cwd,
      env: { ...process.env, INIT_CWD: cwd, ...env },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code,
      });
    });
  });
};

const makeFixtureDir = async (files: Record<string, string | Buffer>) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-digest-cli-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(tempDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  return tempDir;
};

const extractFenceContent = (digest: string, fileName: string) => {
  const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = digest.match(
    new RegExp(
      `# ${escapedFileName}\\n\\n\`\`\`[^\\n]*\\n([\\s\\S]*?)\\n\`\`\``
    )
  );
  return match?.[1] ?? "";
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
});

describe("AI Digest CLI --stdout", () => {
  it("should declare the --stdout option in help output", async () => {
    //harness:criterion=c-stdout-option-declared
    const result = await runCLIProcess(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf-8")).toContain("--stdout");
  }, 10000);

  it("should write non-empty parseable markdown digest content to stdout without success logs", async () => {
    //harness:criterion=c-stdout-writes-content-to-stdout,c-stdout-content-is-parseable-markdown,c-stdout-no-logs-on-stdout,c-stdout-stderr-clean-on-success
    const tempDir = await makeFixtureDir({
      "src/example.ts": "export const answer = 42;\n",
    });

    try {
      const result = await runCLIProcess(["--stdout"], tempDir);
      const stdout = result.stdout.toString("utf-8");
      const stderr = result.stderr.toString("utf-8");

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(stdout.trimStart()).toMatch(/^#\s+/);
      expect(stdout).toContain("```");
      expect(stdout).not.toMatch(
        /Generating|Processing|Writing|Done|files processed|Skipping|Warning/i
      );
      expect(stderr.trim()).toHaveLength(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should not create codebase.md when --stdout is used", async () => {
    //harness:criterion=c-stdout-no-file-created
    const tempDir = await makeFixtureDir({
      "index.js": "console.log(\"hello\");\n",
    });

    try {
      const outputPath = path.join(tempDir, "codebase.md");
      const result = await runCLIProcess(["--stdout"], tempDir);

      await expect(fs.access(outputPath)).rejects.toThrow();
      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should not overwrite an existing default output file when --stdout is used", async () => {
    //harness:criterion=c-stdout-no-file-overwritten
    const tempDir = await makeFixtureDir({
      "index.js": "console.log(\"hello\");\n",
      "codebase.md": "SENTINEL_CONTENT",
    });

    try {
      const outputPath = path.join(tempDir, "codebase.md");
      const result = await runCLIProcess(["--stdout"], tempDir);
      const outputContent = await fs.readFile(outputPath, "utf-8");

      expect(result.code).toBe(0);
      expect(outputContent).toBe("SENTINEL_CONTENT");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should write warnings to stderr and not stdout when --stdout is used", async () => {
    //harness:criterion=c-stdout-warnings-go-to-stderr
    const tempDir = await makeFixtureDir({
      "readable.txt": "included\n",
      "too-large.txt": "",
    });

    try {
      await fs.truncate(path.join(tempDir, "too-large.txt"), 501 * 1024 * 1024);
      const result = await runCLIProcess(["--stdout"], tempDir);
      const stdout = result.stdout.toString("utf-8");
      const stderr = result.stderr.toString("utf-8");

      expect(result.code).toBe(0);
      expect(stderr).toContain("too-large.txt");
      expect(stdout).not.toContain("too-large.txt");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should reject --stdout combined with --watch before writing stdout", async () => {
    //harness:criterion=c-stdout-watch-rejected-nonzero-exit,c-stdout-watch-rejected-stderr-message,c-stdout-watch-rejected-no-stdout-output
    const tempDir = await makeFixtureDir({
      "index.js": "console.log(\"hello\");\n",
    });

    try {
      const result = await runCLIProcess(["--stdout", "--watch"], tempDir);
      const stderr = result.stderr.toString("utf-8");

      expect(result.code).toBe(1);
      expect(stderr).toMatch(
        /(--stdout.*--watch|--watch.*--stdout|incompatible)/i
      );
      expect(result.stdout.length).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should respect ignored path patterns when --stdout is used", async () => {
    //harness:criterion=c-stdout-ignore-flag-respected
    const tempDir = await makeFixtureDir({
      "include.ts": "export const visible = true;\n",
      "secret.ts": "export const hidden = true;\n",
    });

    try {
      const result = await runCLIProcess(
        ["--stdout", "--ignore", "secret.ts"],
        tempDir
      );
      const stdout = result.stdout.toString("utf-8");

      expect(result.code).toBe(0);
      expect(stdout).toContain("include.ts");
      expect(stdout).not.toContain("secret.ts");
      expect(stdout).not.toContain("hidden");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should respect direct minify glob patterns when --stdout is used", async () => {
    //harness:criterion=c-stdout-minify-file-flag-respected
    const original = "function example() {\n\n  console.log(\"verbose\");\n}\n";
    const tempDir = await makeFixtureDir({
      "verbose.js": original,
    });

    try {
      const result = await runCLIProcess(
        ["--stdout", "--minify-file", "*.js"],
        tempDir
      );
      const stdout = result.stdout.toString("utf-8");
      const fileContent = extractFenceContent(stdout, "verbose.js");

      expect(result.code).toBe(0);
      expect(stdout).toContain("# verbose.js");
      expect(fileContent).toContain("console.log(\"verbose\")");
      expect(fileContent).not.toContain("\n\n");
      expect(fileContent).not.toMatch(/^\s{2,}/m);
      expect(stdout).not.toContain(original);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should respect whitespace removal when --stdout is used", async () => {
    //harness:criterion=c-stdout-whitespace-removal-flag-respected
    const tempDir = await makeFixtureDir({
      "spaced.txt": "first\n\n\nsecond\n\n\nthird\n",
    });

    try {
      const result = await runCLIProcess(
        ["--stdout", "--remove-whitespace"],
        tempDir
      );
      const stdout = result.stdout.toString("utf-8");
      const fileContent = extractFenceContent(stdout, "spaced.txt");

      expect(result.code).toBe(0);
      expect(fileContent).toContain("first second third");
      expect(fileContent).not.toContain("\n\n\n");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should ignore -o writes and still emit digest content when --stdout is used", async () => {
    //harness:criterion=c-stdout-output-flag-ignored-for-writes
    const tempDir = await makeFixtureDir({
      "index.js": "console.log(\"hello\");\n",
    });

    try {
      const customPath = path.join(tempDir, "custom.md");
      const result = await runCLIProcess(
        ["--stdout", "-o", "custom.md"],
        tempDir
      );

      await expect(fs.access(customPath)).rejects.toThrow();
      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);

      await fs.writeFile(customPath, "CUSTOM_SENTINEL");
      const overwriteResult = await runCLIProcess(
        ["--stdout", "-o", "custom.md"],
        tempDir
      );
      const customContent = await fs.readFile(customPath, "utf-8");

      expect(overwriteResult.code).toBe(0);
      expect(overwriteResult.stdout.length).toBeGreaterThan(0);
      expect(customContent).toBe("CUSTOM_SENTINEL");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should preserve digest bytes exactly between file output and --stdout", async () => {
    //harness:criterion=c-stdout-content-byte-preservation
    const tempDir = await makeFixtureDir({
      "index.ts": "export const value = \"stable\";\n",
    });

    try {
      const outputPath = path.join(tempDir, "codebase.md");
      const fileResult = await runCLIProcess([], tempDir);
      const fileBytes = await fs.readFile(outputPath);

      await fs.unlink(outputPath);
      const stdoutResult = await runCLIProcess(["--stdout"], tempDir);

      expect(fileResult.code).toBe(0);
      expect(stdoutResult.code).toBe(0);
      expect(stdoutResult.stdout.equals(fileBytes)).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should keep normal file output and stdout logs unchanged without --stdout", async () => {
    //harness:criterion=c-no-stdout-behavior-unchanged
    const tempDir = await makeFixtureDir({
      "index.js": "console.log(\"hello\");\n",
    });

    try {
      const outputPath = path.join(tempDir, "codebase.md");
      const result = await runCLIProcess([], tempDir);
      const fileBytes = await fs.readFile(outputPath);
      const stdout = result.stdout.toString("utf-8");

      expect(result.code).toBe(0);
      expect(fileBytes.length).toBeGreaterThan(0);
      expect(stdout).toMatch(
        /Generating|Processing|Writing|Done|files processed|Files aggregated successfully/i
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should document the --stdout option, usage, watch incompatibility, and package versions", async () => {
    //harness:criterion=c-readme-stdout-option-documented,c-readme-stdout-usage-example,c-readme-stdout-watch-incompatibility-noted,c-version-bumped-to-1-6-0,c-package-lock-version-bumped-to-1-6-0
    const repoRoot = path.resolve(__dirname, "..");
    const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf-8");
    const packageJson = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf-8")
    );
    const packageLockJson = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf-8")
    );
    const stdoutOptionLine = readme
      .split("\n")
      .find((line) => line.includes("--stdout"));
    const stdoutIndex = readme.indexOf("--stdout");
    const watchIndex = readme.indexOf("--watch", stdoutIndex);
    const surroundingNote =
      stdoutIndex === -1 || watchIndex === -1
        ? ""
        : readme.slice(
            Math.max(0, stdoutIndex - 250),
            Math.min(readme.length, watchIndex + 250)
          );

    expect(stdoutOptionLine).toMatch(/\|.*--stdout.*\|/);
    expect(readme).toMatch(/--stdout\s*(\||>)/);
    expect(Math.abs(watchIndex - stdoutIndex)).toBeLessThanOrEqual(500);
    expect(surroundingNote).toMatch(/incompatible|cannot|error|rejected/i);
    expect(packageJson.version).toBe("1.6.0");
    expect(packageLockJson.version).toBe("1.6.0");
  });
});
