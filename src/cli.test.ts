import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";

const execAsync = promisify(exec);
const execAsyncBuffer = promisify(exec) as (
  command: string,
  options: { encoding: "buffer"; maxBuffer?: number; timeout?: number }
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

const LOG_OUTPUT_PATTERN =
  /Processing|Generating|Summary|Warning|Error|files found|tokens|Output written|Files aggregated successfully|Files included in output|Done! Wrote code base/i;
const WATCH_STDOUT_ERROR_PATTERN =
  /watch.*stdout|stdout.*watch|unsupported|not supported/i;

const shellQuote = (value: string) =>
  `'${value.replace(/'/g, "'\\''")}'`;

const runCLI = async (args: string = "") => {
  const cliPath = path.resolve(__dirname, "index.ts");
  return execAsync(`ts-node ${cliPath} ${args}`);
};

const runCLIBuffer = async (args: string = "", timeout = 10000) => {
  const cliPath = path.resolve(__dirname, "index.ts");
  return execAsyncBuffer(`ts-node ${cliPath} ${args}`, {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 20,
    timeout,
  });
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

  describe("stdout option", () => {
    const rootCodebasePath = path.resolve(__dirname, "..", "codebase.md");

    const createStdoutFixture = async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-test-")
      );

      await fs.writeFile(
        path.join(tempDir, "alpha.ts"),
        [
          "export function alpha() {",
          "  return 'alpha';",
          "}",
          "",
        ].join("\n")
      );
      await fs.writeFile(
        path.join(tempDir, "spacing.txt"),
        "hello   \n\nworld\n"
      );
      await fs.mkdir(path.join(tempDir, "node_modules"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "node_modules", "ignored.js"),
        "default ignored content"
      );
      await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".git", "config"),
        "default ignored git content"
      );

      return tempDir;
    };

    afterEach(async () => {
      await fs.unlink(rootCodebasePath).catch(() => {});
    });

    it("lists --stdout in CLI help", async () => {
      //harness:criterion=c-stdout-flag-exists
      const { stdout } = await runCLI("--help");

      expect(stdout).toContain("--stdout");
    }, 10000);

    it("writes only raw digest content to stdout without creating the default output file", async () => {
      //harness:criterion=c-stdout-writes-to-stdout,c-stdout-no-file-created,c-stdout-no-log-strings-on-stdout,c-stdout-logs-go-to-stderr-or-suppressed,c-stdout-respects-default-ignores,c-stdout-preserves-trailing-whitespace,c-stdout-preserves-blank-lines,c-stdout-no-write-digest-to-file-called,c-stdout-no-aggregate-files-called
      const tempDir = await createStdoutFixture();
      await fs.unlink(rootCodebasePath).catch(() => {});

      try {
        const { stdout } = await runCLIBuffer(`--stdout ${shellQuote(tempDir)}`);
        const stdoutText = stdout.toString("utf-8");

        expect(stdout.length).toBeGreaterThan(0);
        expect(stdoutText).toContain("# alpha.ts");
        expect(stdoutText).toContain("export function alpha()");
        expect(stdoutText).not.toMatch(LOG_OUTPUT_PATTERN);
        expect(stdoutText).not.toContain("node_modules");
        expect(stdoutText).not.toContain(".git");
        expect(stdout.includes(Buffer.from("hello   \n"))).toBe(true);
        expect(stdoutText).toContain("hello   \n\nworld");
        expect(fsSync.existsSync(rootCodebasePath)).toBe(false);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("does not overwrite an existing default output file in stdout mode", async () => {
      //harness:criterion=c-stdout-no-file-created,c-stdout-no-write-digest-to-file-called,c-stdout-no-aggregate-files-called
      const tempDir = await createStdoutFixture();
      const existingContent = "existing digest should remain untouched\n";

      try {
        await fs.writeFile(rootCodebasePath, existingContent);

        const { stdout } = await runCLI(`--stdout ${shellQuote(tempDir)}`);
        const afterContent = await fs.readFile(rootCodebasePath, "utf-8");

        expect(stdout).toContain("# alpha.ts");
        expect(afterContent).toBe(existingContent);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.unlink(rootCodebasePath).catch(() => {});
      }
    }, 15000);

    it("matches normal file output byte-for-byte", async () => {
      //harness:criterion=c-stdout-content-matches-file-content
      const tempDir = await createStdoutFixture();
      const outputFile = path.join(
        os.tmpdir(),
        `ai-digest-file-output-${Date.now()}.md`
      );

      try {
        await fs.unlink(outputFile).catch(() => {});
        await runCLI(`-o ${shellQuote(outputFile)} ${shellQuote(tempDir)}`);
        const fileBuffer = await fs.readFile(outputFile);
        const { stdout } = await runCLIBuffer(`--stdout ${shellQuote(tempDir)}`);

        expect(Buffer.compare(stdout, fileBuffer)).toBe(0);
      } finally {
        await fs.unlink(outputFile).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("uses the positional custom input directory in stdout mode", async () => {
      //harness:criterion=c-stdout-with-custom-input-dir
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-custom-dir-")
      );

      try {
        await fs.writeFile(path.join(tempDir, "hello.txt"), "hello from temp");
        const { stdout } = await runCLI(`${shellQuote(tempDir)} --stdout`);

        expect(stdout).toContain("# hello.txt");
        expect(stdout).toContain("hello from temp");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("respects custom ignore files in stdout mode", async () => {
      //harness:criterion=c-stdout-respects-custom-ignore
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-ignore-")
      );

      try {
        await fs.writeFile(path.join(tempDir, "included.ts"), "included");
        await fs.writeFile(path.join(tempDir, "excluded.ts"), "excluded");
        await fs.writeFile(path.join(tempDir, ".myignore"), "excluded.ts\n");

        const { stdout } = await runCLI(
          `${shellQuote(tempDir)} --stdout --ignore-file=.myignore`
        );

        expect(stdout).toContain("# included.ts");
        expect(stdout).toContain("included");
        expect(stdout).not.toContain("excluded.ts");
        expect(stdout).not.toContain("excluded");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("respects minify patterns in stdout mode", async () => {
      //harness:criterion=c-stdout-respects-minify
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-minify-")
      );

      try {
        const largeContent = "const largeValue = 'content';\n".repeat(100);
        await fs.writeFile(
          path.join(tempDir, "regular.ts"),
          "export const ok = true;\n"
        );
        await fs.writeFile(path.join(tempDir, "large.ts"), largeContent);
        await fs.writeFile(path.join(tempDir, ".aidigestminify"), "large.ts\n");

        const withMinify = await runCLIBuffer(`--stdout ${shellQuote(tempDir)}`);
        await fs.unlink(path.join(tempDir, ".aidigestminify"));
        const withoutMinify = await runCLIBuffer(
          `--stdout ${shellQuote(tempDir)}`
        );
        const minifiedText = withMinify.stdout.toString("utf-8");

        expect(withMinify.stdout.length).toBeLessThan(
          withoutMinify.stdout.length
        );
        expect(minifiedText).toContain("# large.ts");
        expect(minifiedText).toContain("This is a minified file of type: .ts");
        expect(minifiedText).not.toContain(largeContent.trim());
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("respects whitespace removal in stdout mode", async () => {
      //harness:criterion=c-stdout-respects-whitespace-removal
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-whitespace-")
      );

      try {
        await fs.writeFile(
          path.join(tempDir, "messy.ts"),
          "const   value   =   1;\n\n\nfunction   messy()   {   return   value;   }\n"
        );

        const normal = await runCLIBuffer(`--stdout ${shellQuote(tempDir)}`);
        const compact = await runCLIBuffer(
          `--stdout --whitespace-removal ${shellQuote(tempDir)}`
        );
        const compactText = compact.stdout.toString("utf-8");

        expect(compact.stdout.length).toBeLessThanOrEqual(normal.stdout.length);
        expect(compactText).not.toContain("const   value");
        expect(compactText).toContain("const value = 1;");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("rejects watch mode with stdout and keeps the unsupported-combination message off stdout", async () => {
      //harness:criterion=c-stdout-watch-rejected,c-stdout-watch-error-not-on-stdout
      const tempDir = await createStdoutFixture();

      try {
        let stdoutText = "";
        let stderrText = "";
        let exitCode = 0;
        let timedOut = false;

        try {
          const result = await runCLIBuffer(
            `--stdout --watch ${shellQuote(tempDir)}`,
            3000
          );
          stdoutText = result.stdout.toString("utf-8");
          stderrText = result.stderr.toString("utf-8");
        } catch (error) {
          const execError = error as {
            stdout?: Buffer;
            stderr?: Buffer;
            code?: number;
            killed?: boolean;
          };
          stdoutText = execError.stdout?.toString("utf-8") ?? "";
          stderrText = execError.stderr?.toString("utf-8") ?? "";
          exitCode = typeof execError.code === "number" ? execError.code : 0;
          timedOut = execError.killed ?? false;
        }

        expect(timedOut).toBe(false);
        expect(
          exitCode !== 0 || WATCH_STDOUT_ERROR_PATTERN.test(stderrText)
        ).toBe(true);
        expect(stdoutText).not.toMatch(WATCH_STDOUT_ERROR_PATTERN);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 10000);

    it("ignores custom output files and show-output-files on stdout", async () => {
      //harness:criterion=c-stdout-custom-output-flag-ignored-or-warned,c-stdout-show-output-files-not-on-stdout
      const tempDir = await createStdoutFixture();
      const customOutputFile = path.join(
        os.tmpdir(),
        `ai-digest-stdout-custom-${Date.now()}.md`
      );

      try {
        await fs.unlink(customOutputFile).catch(() => {});
        const { stdout, stderr } = await runCLI(
          `--stdout --show-output-files -o ${shellQuote(customOutputFile)} ${shellQuote(tempDir)}`
        );

        expect(stdout).toContain("# alpha.ts");
        expect(stdout).not.toMatch(
          /Output files:|output files written|Files included in the output/i
        );
        expect(fsSync.existsSync(customOutputFile)).toBe(false);
        expect(stderr).toEqual(expect.any(String));
      } finally {
        await fs.unlink(customOutputFile).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("does not overwrite an existing custom output file in stdout mode", async () => {
      //harness:criterion=c-stdout-custom-output-flag-ignored-or-warned,c-stdout-no-file-created
      const tempDir = await createStdoutFixture();
      const customOutputFile = path.join(
        os.tmpdir(),
        `ai-digest-stdout-existing-custom-${Date.now()}.md`
      );
      const existingContent = "existing custom digest should remain untouched\n";

      try {
        await fs.writeFile(customOutputFile, existingContent);

        const { stdout } = await runCLI(
          `--stdout -o ${shellQuote(customOutputFile)} ${shellQuote(tempDir)}`
        );
        const afterContent = await fs.readFile(customOutputFile, "utf-8");

        expect(stdout).toContain("# alpha.ts");
        expect(stdout).not.toMatch(LOG_OUTPUT_PATTERN);
        expect(afterContent).toBe(existingContent);
      } finally {
        await fs.unlink(customOutputFile).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("still writes codebase.md and emits logs when stdout is omitted", async () => {
      //harness:criterion=c-no-stdout-default-file-still-created,c-no-stdout-logs-still-visible
      const tempDir = await createStdoutFixture();
      await fs.unlink(rootCodebasePath).catch(() => {});

      try {
        const { stdout, stderr } = await runCLI(`${shellQuote(tempDir)}`);
        const combinedOutput = `${stdout}${stderr}`;

        expect(fsSync.existsSync(rootCodebasePath)).toBe(true);
        expect(fsSync.statSync(rootCodebasePath).size).toBeGreaterThan(0);
        expect(combinedOutput).toMatch(
          /Output written|files found|tokens|Files aggregated successfully/i
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.unlink(rootCodebasePath).catch(() => {});
      }
    }, 15000);

    it("remains composable in shell pipelines", async () => {
      //harness:criterion=c-stdout-pipeline-composable
      const tempDir = await createStdoutFixture();

      try {
        const cliPath = path.resolve(__dirname, "index.ts");
        const { stdout } = await execAsync(
          `ts-node ${cliPath} --stdout ${shellQuote(tempDir)} | grep 'function'`
        );
        const lines = stdout.trim().split("\n").filter(Boolean);

        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line).toMatch(/function/);
          expect(line).not.toMatch(LOG_OUTPUT_PATTERN);
        }
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("documents and versions the stdout option", async () => {
      //harness:criterion=c-package-version-bumped,c-readme-documents-stdout,c-claude-md-updated
      const packageJson = JSON.parse(
        await fs.readFile(path.resolve(__dirname, "..", "package.json"), "utf-8")
      );
      const readme = await fs.readFile(
        path.resolve(__dirname, "..", "README.md"),
        "utf-8"
      );
      const claudeMd = await fs.readFile(
        path.resolve(__dirname, "..", "CLAUDE.md"),
        "utf-8"
      );

      expect(packageJson.version).toBe("1.6.0");
      expect(readme).toContain("--stdout");
      expect(readme.match(/--stdout/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(
        readme
          .split("\n")
          .some((line) => line.includes("--stdout") && line.includes("|"))
      ).toBe(true);
      expect(claudeMd).toContain("--stdout");
    }, 10000);
  });
});
