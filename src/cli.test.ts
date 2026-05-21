import { exec, spawn, spawnSync } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";

const execAsync = promisify(exec);
const cliPath = path.resolve(__dirname, "index.ts");
const tsNodeBin = path.resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ts-node.cmd" : "ts-node"
);

const runCLI = async (args: string = "") => {
  return execAsync(`ts-node ${cliPath} ${args}`);
};

const runCLISync = (
  args: string[] = [],
  env: Record<string, string> = {}
) => {
  return spawnSync(tsNodeBin, [cliPath, ...args], {
    encoding: "buffer",
    env: {
      ...process.env,
      ...env,
    },
  });
};

const outputString = (value: Buffer | string | null): string => {
  return Buffer.isBuffer(value) ? value.toString("utf-8") : value || "";
};

const fileExists = async (filePath: string): Promise<boolean> => {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
};

const parseDigestHeaders = (content: string): string[] => {
  return [...content.matchAll(/^# (.+)$/gm)]
    .map((match) => match[1])
    .sort();
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

  describe("--stdout contract", () => {
    const makeFixture = async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-test-")
      );

      await fs.writeFile(path.join(tempDir, "alpha.txt"), "Alpha content\n");
      await fs.writeFile(
        path.join(tempDir, "script.js"),
        "function example() {\n    console.log(\"many    spaces\");\n\n}\n"
      );
      await fs.mkdir(path.join(tempDir, "subdir"));
      await fs.writeFile(
        path.join(tempDir, "subdir", "nested.txt"),
        "Nested content\n"
      );

      return tempDir;
    };

    it("lists the stdout flag in help output", () => {
      // harness:criterion=c-stdout-flag-declared
      const result = runCLISync(["--help"]);

      expect(result.status).toBe(0);
      expect(outputString(result.stdout)).toContain("--stdout");
    });

    it("writes only digest content to stdout and does not create output files", async () => {
      // harness:criterion=c-stdout-writes-digest-to-stdout,c-stdout-no-output-file-created,c-stdout-logs-absent-from-stdout
      const tempDir = await makeFixture();
      const explicitOutputPath = path.join(tempDir, "explicit-output.md");
      const existingOutputContent = "existing output must remain unchanged\n";

      try {
        await fs.writeFile(explicitOutputPath, existingOutputContent);

        const result = runCLISync(
          ["--input", tempDir, "--stdout", "-o", explicitOutputPath],
          { INIT_CWD: tempDir }
        );
        const stdout = outputString(result.stdout);

        expect(result.status).toBe(0);
        expect(stdout.length).toBeGreaterThan(0);
        expect(stdout).toContain("# alpha.txt");
        expect(stdout).toContain("Alpha content");
        expect(stdout).not.toMatch(
          /Processing|files processed|Generated|Writing|Files aggregated successfully|Scanning directory|Total files found/
        );
        expect(await fileExists(path.join(tempDir, "codebase.md"))).toBe(
          false
        );
        await expect(fs.readFile(explicitOutputPath, "utf-8")).resolves.toBe(
          existingOutputContent
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("writes warning and error details to stderr without contaminating stdout", async () => {
      // harness:criterion=c-stdout-errors-go-to-stderr
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-stderr-test-")
      );
      const unreadableFile = path.join(tempDir, "no-read.txt");

      try {
        await fs.writeFile(unreadableFile, "Secret content");
        await fs.chmod(unreadableFile, 0o000);

        const result = runCLISync(["--input", tempDir, "--stdout"], {
          INIT_CWD: tempDir,
        });
        const stdout = outputString(result.stdout);
        const stderr = outputString(result.stderr);

        expect(result.status).toBe(0);
        expect(stderr).toContain("Error checking if file is binary");
        expect(stderr).toContain("no-read.txt");
        expect(stdout).toContain("# no-read.txt");
        expect(stdout).not.toContain("Error checking if file is binary");
      } finally {
        await fs.chmod(unreadableFile, 0o600).catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects stdout and watch together with stderr-only error output", async () => {
      // harness:criterion=c-stdout-watch-rejected,c-stdout-watch-rejection-no-stdout-output
      const tempDir = await makeFixture();

      try {
        const result = runCLISync(["--input", tempDir, "--stdout", "--watch"], {
          INIT_CWD: tempDir,
        });
        const stderr = outputString(result.stderr);

        expect(result.status).not.toBe(0);
        expect(outputString(result.stdout)).toHaveLength(0);
        expect(stderr).toContain("--stdout");
        expect(stderr).toContain("--watch");
        expect(stderr).toMatch(/incompatible|cannot|not supported|error/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("matches file-based digest file selection exactly", async () => {
      // harness:criterion=c-stdout-file-selection-honored,c-stdout-content-byte-preserving
      const tempDir = await makeFixture();

      try {
        const stdoutResult = runCLISync(["--input", tempDir, "--stdout"], {
          INIT_CWD: tempDir,
        });
        expect(stdoutResult.status).toBe(0);

        const fileResult = runCLISync(["--input", tempDir], {
          INIT_CWD: tempDir,
        });
        expect(fileResult.status).toBe(0);

        const fileBuffer = await fs.readFile(path.join(tempDir, "codebase.md"));
        const stdoutBuffer = stdoutResult.stdout as Buffer;

        expect(parseDigestHeaders(stdoutBuffer.toString("utf-8"))).toEqual(
          parseDigestHeaders(fileBuffer.toString("utf-8"))
        );
        expect(Buffer.compare(stdoutBuffer, fileBuffer)).toBe(0);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("honors default and custom ignore rules in stdout mode", async () => {
      // harness:criterion=c-stdout-default-ignore-honored,c-stdout-custom-ignore-honored
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-ignore-test-")
      );

      try {
        await fs.writeFile(path.join(tempDir, "a.txt"), "A content");
        await fs.writeFile(path.join(tempDir, "b.txt"), "B content");
        await fs.mkdir(path.join(tempDir, "node_modules"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(tempDir, "node_modules", "ignored.js"),
          "ignored by default"
        );
        await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
        await fs.writeFile(
          path.join(tempDir, ".git", "config"),
          "ignored git config"
        );
        await fs.writeFile(path.join(tempDir, "custom.ignore"), "b.txt\n");

        const result = runCLISync(
          ["--input", tempDir, "--stdout", "--ignore-file", "custom.ignore"],
          { INIT_CWD: tempDir }
        );
        const stdout = outputString(result.stdout);

        expect(result.status).toBe(0);
        expect(stdout).toContain("# a.txt");
        expect(stdout).not.toContain("# b.txt");
        expect(stdout).not.toContain("node_modules/ignored.js");
        expect(stdout).not.toContain(".git/config");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("matches file output when stdout mode uses minify-file and whitespace-removal", async () => {
      // harness:criterion=c-stdout-minify-file-honored,c-stdout-whitespace-removal-honored
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-transform-test-")
      );

      try {
        await fs.writeFile(
          path.join(tempDir, "regular.js"),
          "function regular() {\n    console.log(\"many    spaces\");\n\n}\n"
        );
        await fs.writeFile(
          path.join(tempDir, "bundle.min.js"),
          "function bundled(){console.log(\"minified source\")}"
        );
        await fs.writeFile(path.join(tempDir, "custom.minify"), "*.min.js\n");

        const stdoutResult = runCLISync(
          [
            "--input",
            tempDir,
            "--stdout",
            "--minify-file",
            "custom.minify",
            "--whitespace-removal",
          ],
          { INIT_CWD: tempDir }
        );
        expect(stdoutResult.status).toBe(0);

        const fileResult = runCLISync(
          [
            "--input",
            tempDir,
            "--minify-file",
            "custom.minify",
            "--whitespace-removal",
          ],
          { INIT_CWD: tempDir }
        );
        expect(fileResult.status).toBe(0);

        const stdout = outputString(stdoutResult.stdout);
        const fileContent = await fs.readFile(
          path.join(tempDir, "codebase.md"),
          "utf-8"
        );

        expect(stdout).toBe(fileContent);
        expect(stdout).toContain("# bundle.min.js");
        expect(stdout).toContain("This is a minified file of type: .js");
        expect(stdout).not.toContain("minified source");
        expect(stdout).toContain(
          "function regular() { console.log(\"many spaces\"); }"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("preserves file-writing behavior when stdout is absent", async () => {
      // harness:criterion=c-stdout-absent-no-file-behavior-unchanged
      const tempDir = await makeFixture();

      try {
        const result = runCLISync(["--input", tempDir], {
          INIT_CWD: tempDir,
        });
        const outputPath = path.join(tempDir, "codebase.md");
        const stats = await fs.stat(outputPath);

        expect(result.status).toBe(0);
        expect(stats.size).toBeGreaterThan(0);
        expect(outputString(result.stdout)).toMatch(
          /Files aggregated successfully|Files included in output|Total files found/
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it("keeps watch mode usable when stdout is absent", async () => {
      // harness:criterion=c-stdout-watch-alone-still-works
      const tempDir = await makeFixture();

      try {
        const result = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
          stderr: string;
        }>((resolve, reject) => {
          const child = spawn(tsNodeBin, [cliPath, "--input", tempDir, "--watch"], {
            env: {
              ...process.env,
              INIT_CWD: tempDir,
              NODE_ENV: "test",
            },
          });
          let stderr = "";
          const timeout = setTimeout(() => {
            child.kill("SIGINT");
          }, 2000);

          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.on("close", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stderr });
          });
        });

        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stderr).not.toMatch(/--stdout.*--watch|--watch.*--stdout/);
        expect(result.stderr).not.toMatch(/incompatible|cannot|not supported/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 10000);

    it("documents stdout usage, watch incompatibility, and package version", async () => {
      // harness:criterion=c-stdout-readme-documents-flag,c-stdout-readme-documents-watch-incompatibility,c-stdout-package-version-bumped
      const readme = await fs.readFile(
        path.resolve(__dirname, "..", "README.md"),
        "utf-8"
      );
      const packageJson = JSON.parse(
        await fs.readFile(path.resolve(__dirname, "..", "package.json"), "utf-8")
      );
      const stdoutLines = readme
        .split(/\r?\n/)
        .filter((line) => line.includes("--stdout"));
      const paragraphs = readme.split(/\n\s*\n/);

      expect(readme).toContain("--stdout");
      expect(
        stdoutLines.some((line) => line.includes("|") || line.includes(">"))
      ).toBe(true);
      expect(
        paragraphs.some(
          (paragraph) =>
            paragraph.includes("--stdout") &&
            paragraph.includes("--watch") &&
            /incompatible|cannot|not supported|error/i.test(paragraph)
        )
      ).toBe(true);
      expect(packageJson.version).toBe("1.6.0");
    });
  });
});
