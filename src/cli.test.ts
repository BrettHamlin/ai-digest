import { exec, execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import os from "os";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const tsNodeBinPath = require.resolve("ts-node/dist/bin.js");

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

type CLIResult = {
  stdout: string;
  stderr: string;
  code: number;
};

const runCLIInDir = async (
  args: string[] = [],
  cwd: string = process.cwd(),
  env: Record<string, string> = {},
  timeout: number = 15000
): Promise<CLIResult> => {
  const cliPath = path.resolve(__dirname, "index.ts");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsNodeBinPath, cliPath, ...args],
      {
        cwd,
        env: { ...process.env, INIT_CWD: cwd, ...env },
        timeout,
        maxBuffer: 1024 * 1024 * 20,
      }
    );

    return { stdout, stderr, code: 0 };
  } catch (caught) {
    const error = caught as {
      stdout?: string;
      stderr?: string;
      code?: number | string | null;
    };

    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      code: typeof error.code === "number" ? error.code : 1,
    };
  }
};

const createStdoutFixture = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ai-digest-stdout-test-")
  );
  await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, "src", "index.ts"),
    "export const answer = 42;\n"
  );
  await fs.writeFile(path.join(tempDir, "notes.txt"), "plain notes\n");
  return tempDir;
};

const pathExists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

const trimTrailingNewlines = (value: string): string =>
  value.replace(/(?:\r?\n)+$/g, "");

const delimiterLines = (value: string): string[] =>
  value.split(/\r?\n/).filter((line) => /={5,}/.test(line));

const spawnWatchInDir = async (
  cwd: string,
  timeout: number = 2000
): Promise<{ code: number | "running"; stdout: string; stderr: string }> => {
  const cliPath = path.resolve(__dirname, "index.ts");
  const child = spawn(
    process.execPath,
    [tsNodeBinPath, cliPath, "--watch"],
    {
      cwd,
      env: { ...process.env, INIT_CWD: cwd },
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (code: number | "running") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    timer = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      finish("running");
    }, timeout);

    child.on("exit", (code) => {
      finish(code ?? 0);
    });
  });
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

  describe("--stdout mode", () => {
    it("should list the stdout flag in help output", async () => {
      // harness:criterion=c-stdout-flag-defined
      const { stdout, code } = await runCLIInDir(["--help"]);

      expect(code).toBe(0);
      expect(stdout).toContain("--stdout");
    }, 10000);

    it("should write non-empty parseable digest content to stdout", async () => {
      // harness:criterion=c-stdout-content-nonempty,c-stdout-content-parseable
      const tempDir = await createStdoutFixture();

      try {
        const { stdout, code } = await runCLIInDir(["--stdout"], tempDir);

        expect(code).toBe(0);
        expect(stdout.length).toBeGreaterThan(0);
        expect(stdout).toContain("==========");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should not create the default output file in stdout mode", async () => {
      // harness:criterion=c-stdout-no-output-file-created
      const tempDir = await createStdoutFixture();
      const outputPath = path.join(tempDir, "codebase.md");

      try {
        expect(await pathExists(outputPath)).toBe(false);

        const { code } = await runCLIInDir(["--stdout"], tempDir);

        expect(code).toBe(0);
        expect(await pathExists(outputPath)).toBe(false);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should keep progress and informational log lines off stdout", async () => {
      // harness:criterion=c-stdout-no-progress-on-stdout,c-stdout-logs-on-stderr
      const tempDir = await createStdoutFixture();

      try {
        const { stdout, code } = await runCLIInDir(["--stdout"], tempDir);

        expect(code).toBe(0);
        expect(stdout).not.toMatch(
          /Processing|Wrote|Generated|files included|Summary/i
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should write stdout-mode validation errors to stderr only", async () => {
      // harness:criterion=c-stdout-errors-on-stderr
      const tempDir = await createStdoutFixture();

      try {
        const { stdout, stderr, code } = await runCLIInDir(
          ["--stdout", "--definitely-not-a-real-flag"],
          tempDir
        );

        expect(code).not.toBe(0);
        expect(stderr.trim().length).toBeGreaterThan(0);
        expect(stderr).toMatch(/error|unknown option/i);
        expect(stdout.trim()).toBe("");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should reject combining stdout mode with watch mode", async () => {
      // harness:criterion=c-stdout-watch-rejected-exit-1,c-stdout-watch-rejected-stderr-message,c-stdout-watch-rejected-no-stdout-output
      const tempDir = await createStdoutFixture();

      try {
        const { stdout, stderr, code } = await runCLIInDir(
          ["--stdout", "--watch"],
          tempDir
        );

        expect(code).toBe(1);
        expect(stderr.trim().length).toBeGreaterThan(0);
        expect(stderr).toMatch(
          /stdout.*watch|watch.*stdout|cannot.*combine|incompatible/i
        );
        expect(stdout.trim()).toBe("");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should exclude the default output path from stdout digest content", async () => {
      // harness:criterion=c-stdout-output-file-excluded-from-digest
      const tempDir = await createStdoutFixture();

      try {
        await fs.writeFile(
          path.join(tempDir, "codebase.md"),
          "generated digest should be excluded\n"
        );

        const { stdout, code } = await runCLIInDir(["--stdout"], tempDir);

        expect(code).toBe(0);
        expect(stdout).not.toContain("# codebase.md");
        expect(stdout).not.toContain("generated digest should be excluded");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should exclude a custom output path from stdout digest content", async () => {
      // harness:criterion=c-stdout-custom-output-excluded-from-digest
      const tempDir = await createStdoutFixture();

      try {
        await fs.writeFile(
          path.join(tempDir, "custom.md"),
          "custom output content should be excluded\n"
        );

        const { stdout, code } = await runCLIInDir(
          ["--stdout", "--output=custom.md"],
          tempDir
        );

        expect(code).toBe(0);
        expect(stdout).not.toContain("# custom.md");
        expect(stdout).not.toContain("custom output content should be excluded");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should honor .aidigestignore patterns in stdout mode", async () => {
      // harness:criterion=c-stdout-ignore-honored
      const tempDir = await createStdoutFixture();

      try {
        await fs.writeFile(path.join(tempDir, "secret.txt"), "do not include\n");
        await fs.writeFile(path.join(tempDir, ".aidigestignore"), "secret.txt\n");

        const { stdout, code } = await runCLIInDir(["--stdout"], tempDir);

        expect(code).toBe(0);
        expect(stdout).toContain("# src/index.ts");
        expect(stdout).not.toContain("# secret.txt");
        expect(stdout).not.toContain("do not include");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should match file-output minify behavior in stdout mode", async () => {
      // harness:criterion=c-stdout-minify-honored
      const tempDir = await createStdoutFixture();

      try {
        await fs.writeFile(
          path.join(tempDir, "vendor.min.js"),
          "function minified(){return 1;}\n"
        );
        await fs.writeFile(
          path.join(tempDir, ".aidigestminify"),
          "vendor.min.js\n"
        );

        const stdoutRun = await runCLIInDir(["--stdout", "--minify"], tempDir);
        const fileRun = await runCLIInDir(
          ["--output=out.md", "--minify"],
          tempDir
        );
        const fileContent = await fs.readFile(
          path.join(tempDir, "out.md"),
          "utf-8"
        );

        expect(stdoutRun.code).toBe(0);
        expect(fileRun.code).toBe(0);
        expect(trimTrailingNewlines(stdoutRun.stdout)).toBe(
          trimTrailingNewlines(fileContent)
        );
        expect(stdoutRun.stdout).toContain("# vendor.min.js");
        expect(stdoutRun.stdout).toContain(
          "excluded from the codebase digest"
        );
        expect(stdoutRun.stdout).not.toContain("function minified()");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should match file-output whitespace removal behavior in stdout mode", async () => {
      // harness:criterion=c-stdout-whitespace-removal-honored
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ai-digest-stdout-whitespace-test-")
      );

      try {
        await fs.writeFile(
          path.join(tempDir, "sample.js"),
          "function demo() {\n  return 1;\n}\n"
        );

        const stdoutRun = await runCLIInDir(
          ["--stdout", "--remove-comments"],
          tempDir
        );
        const fileRun = await runCLIInDir(
          ["--output=out.md", "--remove-comments"],
          tempDir
        );
        const fileContent = await fs.readFile(
          path.join(tempDir, "out.md"),
          "utf-8"
        );

        expect(stdoutRun.code).toBe(0);
        expect(fileRun.code).toBe(0);
        expect(trimTrailingNewlines(stdoutRun.stdout)).toBe(
          trimTrailingNewlines(fileContent)
        );
        expect(stdoutRun.stdout).toContain("function demo() { return 1; }");
        expect(stdoutRun.stdout).not.toContain("function demo() {\n  return 1;");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should preserve digest content bytes and delimiter lines from file-output mode", async () => {
      // harness:criterion=c-stdout-preserves-content-bytes,c-stdout-delimiter-bytes-preserved
      const tempDir = await createStdoutFixture();

      try {
        const stdoutRun = await runCLIInDir(["--stdout"], tempDir);
        const fileRun = await runCLIInDir(["--output=out.md"], tempDir);
        const fileContent = await fs.readFile(
          path.join(tempDir, "out.md"),
          "utf-8"
        );
        const stdoutDelimiters = delimiterLines(stdoutRun.stdout);
        const fileDelimiters = delimiterLines(fileContent);

        expect(stdoutRun.code).toBe(0);
        expect(fileRun.code).toBe(0);
        expect(trimTrailingNewlines(stdoutRun.stdout)).toBe(
          trimTrailingNewlines(fileContent)
        );
        expect(stdoutDelimiters.length).toBeGreaterThan(0);
        expect(stdoutDelimiters).toEqual(fileDelimiters);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should keep default file-output behavior when stdout mode is omitted", async () => {
      // harness:criterion=c-no-stdout-flag-default-file-written,c-no-stdout-flag-logs-on-stdout
      const tempDir = await createStdoutFixture();
      const outputPath = path.join(tempDir, "codebase.md");

      try {
        const { stdout, code } = await runCLIInDir([], tempDir);
        const stats = await fs.stat(outputPath);

        expect(code).toBe(0);
        expect(stats.size).toBeGreaterThan(0);
        expect(stdout).toMatch(
          /Processing|Wrote|Generated|files included|Files aggregated successfully|Summary/i
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15000);

    it("should allow watch mode when stdout mode is omitted", async () => {
      // harness:criterion=c-watch-without-stdout-still-works
      const tempDir = await createStdoutFixture();

      try {
        const { code, stderr } = await spawnWatchInDir(tempDir);

        expect(code).not.toBe(1);
        expect(stderr).not.toMatch(/stdout.*watch|watch.*stdout|incompatible/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 10000);

    it("should document stdout usage and watch incompatibility in README", async () => {
      // harness:criterion=c-stdout-flag-in-readme,c-readme-watch-incompatibility-noted
      const readme = await fs.readFile(
        path.resolve(__dirname, "..", "README.md"),
        "utf-8"
      );
      const optionsSection = readme.slice(
        readme.indexOf("## Options"),
        readme.indexOf("## Examples")
      );
      const watchSection = readme.slice(
        readme.indexOf("## Watch Mode"),
        readme.indexOf("## Local Development")
      );

      expect(optionsSection).toContain("--stdout");
      expect(readme).toMatch(/(?:npx\s+)?ai-digest --stdout\s*\|/);
      expect(watchSection).toMatch(
        /--stdout.*cannot.*--watch|--watch.*--stdout|cannot.*combine.*stdout.*watch/i
      );
    });

    it("should bump the package minor version and keep lockfile version in sync", async () => {
      // harness:criterion=c-package-json-minor-bump
      const packageJson = JSON.parse(
        await fs.readFile(path.resolve(__dirname, "..", "package.json"), "utf-8")
      );
      const packageLockJson = JSON.parse(
        await fs.readFile(
          path.resolve(__dirname, "..", "package-lock.json"),
          "utf-8"
        )
      );
      const [, minor] = packageJson.version.split(".").map(Number);

      expect(minor).toBeGreaterThan(5);
      expect(packageLockJson.version).toBe(packageJson.version);
      expect(packageLockJson.packages[""].version).toBe(packageJson.version);
    });
  });
});
