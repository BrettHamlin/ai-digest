import { exec, type ExecException } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";

const execAsync = promisify(exec);
type CliFailure = ExecException & { stdout?: string; stderr?: string };

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const runCLI = async (args: string = "") => {
  const cliPath = path.resolve(__dirname, "index.ts");
  return execAsync(`ts-node ${cliPath} ${args}`);
};

const runCLIInCwd = async (args: string, cwd: string) => {
  const cliPath = path.resolve(__dirname, "index.ts");
  return execAsync(`ts-node ${shellQuote(cliPath)} ${args}`, {
    cwd,
    env: { ...process.env, INIT_CWD: cwd },
    maxBuffer: 10 * 1024 * 1024,
  });
};

const expectCLIToFail = async (args: string, cwd: string) => {
  try {
    await runCLIInCwd(args, cwd);
    throw new Error(`Expected CLI to fail for args: ${args}`);
  } catch (error) {
    const cliError = error as CliFailure;
    if (!("stdout" in cliError) && !("stderr" in cliError)) {
      throw error;
    }
    return {
      code: cliError.code,
      stdout: cliError.stdout ?? "",
      stderr: cliError.stderr ?? "",
    };
  }
};

const pathExists = async (filePath: string) =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

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

  it("should write only valid digest content to stdout without file side effects", async () => {
    //harness:criterion=c-stdout-flag-accepted,c-stdout-writes-digest-to-stdout,c-stdout-digest-valid-format,c-stdout-no-file-created,c-stdout-no-progress-on-stdout,c-stdout-preserves-byte-content,c-stdout-flag-value-like-dash-preserved
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-basic-")
    );

    try {
      const exactBody = "first line\n    indented   \n\n-v\n";
      await fs.writeFile(path.join(tempDir, "foo.txt"), exactBody);
      await fs.writeFile(path.join(tempDir, "bar.txt"), "world");
      const beforeFiles = (await fs.readdir(tempDir)).sort();

      const { stdout, stderr } = await runCLIInCwd("--stdout .", tempDir);

      expect(stderr).not.toMatch(/unknown option/i);
      expect(stdout.length).toBeGreaterThan(0);
      expect(stdout.trimStart()).toMatch(/^(#\s|={3,}|-{3,})/);
      expect(stdout).toContain("# foo.txt");
      expect(stdout).toContain("# bar.txt");
      expect(stdout).toContain("first line");
      expect(stdout).toContain("world");
      expect(stdout).toContain("    indented   ");
      expect(stdout).toContain("\n\n-v\n");
      expect(stdout).not.toMatch(
        /Processing|Scanning|Ignoring|Warning|Summary|files processed|Done/i
      );
      await expect(pathExists(path.join(tempDir, "codebase.md"))).resolves.toBe(
        false
      );
      await expect(fs.readdir(tempDir)).resolves.toEqual(beforeFiles);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should write stdout mode fatal errors to stderr only", async () => {
    //harness:criterion=c-stdout-logs-go-to-stderr
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-error-")
    );
    const missingDir = path.join(tempDir, "missing-input");

    try {
      const { stdout, stderr, code } = await expectCLIToFail(
        `--stdout ${shellQuote(missingDir)}`,
        tempDir
      );

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/error|not found|ENOENT/i);
      expect(stdout).not.toMatch(/error|not found|ENOENT/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should honor default ignores in stdout mode", async () => {
    //harness:criterion=c-stdout-default-ignores-honoured
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-default-ignore-")
    );

    try {
      await fs.writeFile(path.join(tempDir, "visible.txt"), "visible content");
      await fs.mkdir(path.join(tempDir, "node_modules"));
      await fs.writeFile(
        path.join(tempDir, "node_modules", "secret.js"),
        "hidden content"
      );

      const { stdout } = await runCLIInCwd("--stdout .", tempDir);

      expect(stdout).toContain("visible.txt");
      expect(stdout).toContain("visible content");
      expect(stdout).not.toContain("node_modules");
      expect(stdout).not.toContain("secret.js");
      expect(stdout).not.toContain("hidden content");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should honor custom ignore files in stdout mode", async () => {
    //harness:criterion=c-stdout-custom-ignore-file-honoured
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-custom-ignore-")
    );

    try {
      await fs.writeFile(path.join(tempDir, "foo.txt"), "included content");
      await fs.writeFile(path.join(tempDir, "secret.txt"), "excluded content");
      await fs.writeFile(path.join(tempDir, ".aidigestignore"), "secret.txt\n");

      const { stdout } = await runCLIInCwd(
        "--stdout --ignore-file .aidigestignore .",
        tempDir
      );

      expect(stdout).toContain("foo.txt");
      expect(stdout).toContain("included content");
      expect(stdout).not.toContain("secret.txt");
      expect(stdout).not.toContain("excluded content");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should honor minify whitespace removal in stdout mode", async () => {
    //harness:criterion=c-stdout-minify-honoured
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-minify-")
    );

    try {
      await fs.writeFile(
        path.join(tempDir, "spaced.js"),
        "function example() {\n      return    \"value\";\n}\n"
      );

      const normal = await runCLIInCwd("--stdout .", tempDir);
      const minified = await runCLIInCwd("--stdout --minify .", tempDir);

      expect(Buffer.byteLength(minified.stdout)).toBeLessThan(
        Buffer.byteLength(normal.stdout)
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should exclude the resolved output file from stdout selection", async () => {
    //harness:criterion=c-stdout-output-file-excluded-from-selection
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-output-excluded-")
    );

    try {
      await fs.writeFile(path.join(tempDir, "source.txt"), "source content");
      await fs.writeFile(
        path.join(tempDir, "custom-output.md"),
        "output content should not be digested"
      );

      const { stdout } = await runCLIInCwd(
        "--stdout --output custom-output.md .",
        tempDir
      );

      expect(stdout).toContain("# source.txt");
      expect(stdout).toContain("source content");
      expect(stdout).not.toContain("# custom-output.md");
      expect(stdout).not.toContain("output content should not be digested");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should include multiple input directories in natural sort order in stdout mode", async () => {
    //harness:criterion=c-stdout-multiple-input-dirs
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-multiple-")
    );
    const dirA = path.join(tempRoot, "dir-a");
    const dirB = path.join(tempRoot, "dir-b");

    try {
      await fs.mkdir(dirA);
      await fs.mkdir(dirB);
      await fs.writeFile(path.join(dirA, "alpha.txt"), "aaa");
      await fs.writeFile(path.join(dirB, "beta.txt"), "bbb");

      const { stdout } = await runCLIInCwd(
        `--stdout ${shellQuote(dirA)} ${shellQuote(dirB)}`,
        tempRoot
      );

      expect(stdout).toContain("alpha.txt");
      expect(stdout).toContain("aaa");
      expect(stdout).toContain("beta.txt");
      expect(stdout).toContain("bbb");
      expect(stdout.indexOf("alpha.txt")).toBeLessThan(
        stdout.indexOf("beta.txt")
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("should reject combining stdout and watch mode", async () => {
    //harness:criterion=c-stdout-watch-rejected-nonzero,c-stdout-watch-error-on-stderr,c-stdout-watch-nothing-on-stdout
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-stdout-watch-")
    );

    try {
      await fs.writeFile(path.join(tempDir, "file.txt"), "content");

      const { stdout, stderr, code } = await expectCLIToFail(
        "--stdout --watch .",
        tempDir
      );

      expect(code).not.toBe(0);
      expect(stderr).toMatch(
        /cannot.*combine|incompatible|--stdout.*--watch|--watch.*--stdout/i
      );
      expect(stdout.trim()).toBe("");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should preserve default output-file behavior when stdout is omitted", async () => {
    //harness:criterion=c-stdout-omitted-behavior-unchanged
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-digest-no-stdout-")
    );

    try {
      await fs.writeFile(path.join(tempDir, "source.txt"), "source content");

      const { stdout } = await runCLIInCwd(".", tempDir);

      await expect(pathExists(path.join(tempDir, "codebase.md"))).resolves.toBe(
        true
      );
      expect(stdout).toMatch(/Files aggregated successfully into .*codebase\.md/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it("should document stdout usage and watch incompatibility in README", async () => {
    //harness:criterion=c-stdout-readme-option-documented,c-stdout-readme-watch-incompatibility-documented,c-stdout-readme-usage-example
    const readme = await fs.readFile(
      path.resolve(__dirname, "..", "README.md"),
      "utf-8"
    );
    const optionsStart = readme.indexOf("## Options");
    const nextSectionStart = readme.indexOf("\n## ", optionsStart + 1);
    const optionsSection = readme.slice(
      optionsStart,
      nextSectionStart === -1 ? undefined : nextSectionStart
    );
    const fencedBlocks = [...readme.matchAll(/```[\s\S]*?```/g)].map(
      (match) => match[0]
    );
    const inlineCode = [...readme.matchAll(/`[^`\n]*--stdout[^`\n]*`/g)].map(
      (match) => match[0]
    );

    expect(optionsStart).toBeGreaterThanOrEqual(0);
    expect(optionsSection).toContain("--stdout");
    expect(readme).toMatch(/--stdout.*--watch|--watch.*--stdout/is);
    expect(readme).toMatch(/cannot|incompatible|error/i);
    expect(
      fencedBlocks.some((block) => block.includes("--stdout")) ||
        inlineCode.length > 0
    ).toBe(true);
  });

  it("should keep package and lockfile versions aligned with the minor release", async () => {
    //harness:criterion=c-stdout-package-version-bumped
    const packageJson = JSON.parse(
      await fs.readFile(path.resolve(__dirname, "..", "package.json"), "utf-8")
    ) as { version: string };
    const packageLockJson = JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, "..", "package-lock.json"),
        "utf-8"
      )
    ) as { version: string };
    const changelog = await fs.readFile(
      path.resolve(__dirname, "..", "CHANGELOG.md"),
      "utf-8"
    );
    const previousVersionMatch = changelog.match(/###\s+(\d+)\.(\d+)\.(\d+)/);
    expect(previousVersionMatch).not.toBeNull();

    const [, prevMajor, prevMinor] = previousVersionMatch as RegExpMatchArray;
    const [major, minor, patch] = packageJson.version.split(".").map(Number);

    expect(major).toBe(Number(prevMajor));
    expect(minor).toBe(Number(prevMinor) + 1);
    expect(patch).toBe(0);
    expect(packageLockJson.version).toBe(packageJson.version);
  });

  it("should document stdout in CLAUDE.md", async () => {
    //harness:criterion=c-stdout-claude-md-documented
    const claudeMd = await fs.readFile(
      path.resolve(__dirname, "..", "CLAUDE.md"),
      "utf-8"
    );

    expect(claudeMd).toContain("--stdout");
  });
});
