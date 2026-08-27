import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});

const MODEL = "openrouter/free";

const ROOT = process.cwd();

const MAX_FILE_SIZE = 200_000;
const MAX_TOOL_CALLS = 30;

function safePath(relativePath) {
  const resolved = path.resolve(ROOT, relativePath);
  const root = path.resolve(ROOT);

  if (
    resolved !== root &&
    !resolved.startsWith(root + path.sep)
  ) {
    throw new Error(`Unsafe path: ${relativePath}`);
  }

  return resolved;
}

function readFile(relativePath) {
  const filePath = safePath(relativePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${relativePath}`);
  }

  const stat = fs.statSync(filePath);

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${relativePath}`);
  }

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `File is too large to read: ${relativePath}`
    );
  }

  return fs.readFileSync(filePath, "utf8");
}

function writeFile(relativePath, content) {
  const filePath = safePath(relativePath);

  const forbidden = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "credentials",
    "secrets"
  ];

  const lower = relativePath.toLowerCase();

  if (
    forbidden.some(name =>
      lower.includes(name.toLowerCase())
    )
  ) {
    throw new Error(
      `Refusing to modify sensitive file: ${relativePath}`
    );
  }

  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });

  fs.writeFileSync(filePath, content, "utf8");

  return `Successfully wrote ${relativePath}`;
}

function runCommand(command, args = []) {
  console.log(
    `Running: ${command} ${args.join(" ")}`
  );

  try {
    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });

    return {
      success: true,
      output
    };
  } catch (error) {
    return {
      success: false,
      output:
        (error.stdout || "") +
        "\n" +
        (error.stderr || "") +
        `\nExit code: ${error.status ?? "unknown"}`
    };
  }
}

function listFiles() {
  const results = [];

  function walk(directory) {
    const entries = fs.readdirSync(directory, {
      withFileTypes: true
    });

    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".next" ||
        entry.name === "dist" ||
        entry.name === "build"
      ) {
        continue;
      }

      const fullPath = path.join(
        directory,
        entry.name
      );

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const relative = path.relative(
        ROOT,
        fullPath
      );

      if (
        /\.(js|jsx|ts|tsx|mjs|json|css)$/.test(
          relative
        )
      ) {
        results.push(relative);
      }
    }
  }

  walk(ROOT);

  return results;
}

const reportPath = path.join(
  ROOT,
  "qa",
  "reports",
  "qa-report.json"
);

let report = {};

if (fs.existsSync(reportPath)) {
  report = JSON.parse(
    fs.readFileSync(reportPath, "utf8")
  );
}

const files = listFiles();

console.log("QA report:");
console.log(
  JSON.stringify(report, null, 2)
);

console.log(
  `Repository contains ${files.length} source files.`
);

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a source file from the repository. Use this before editing a file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Repository-relative file path."
          }
        },
        required: ["path"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Replace the complete contents of a source file. Only use this when you are confident about the fix.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Repository-relative file path."
          },
          content: {
            type: "string",
            description:
              "Complete new contents of the file."
          }
        },
        required: ["path", "content"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a safe repository verification command.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: [
              "npm"
            ]
          },
          args: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        required: ["command", "args"]
      }
    }
  }
];

const systemPrompt = `
You are the autonomous QA repair agent for GRYND.

GRYND is a skill-based PvP gaming application.

Your task is to investigate and repair ONLY real problems reported by the QA system.

SAFETY RULES:

- Make the smallest possible change.
- Preserve existing functionality.
- Do not redesign the application.
- Do not change game mechanics unless required by the reported bug.
- Do not modify authentication architecture.
- Do not modify Supabase RLS.
- Do not modify wallet/balance logic unless directly required.
- Do not modify payment logic unless directly required.
- Do not modify secrets.
- Do not modify .env files.
- Do not delete tests.
- Do not disable tests.
- Do not remove security checks.
- Do not downgrade dependencies.
- Do not change package versions unless absolutely necessary.
- Never fabricate that a fix worked.
- Always inspect relevant source files before editing.
- If you cannot confidently determine a safe fix, make no changes.

WORKFLOW:

1. Read the QA report.
2. Identify the actual error.
3. Determine which source files are relevant.
4. Read those files.
5. Make the smallest safe correction.
6. Run the relevant tests.
7. If tests fail because of your change, investigate and correct the change.
8. Do not modify unrelated code.
9. Stop when the issue is fixed.

AVAILABLE FILES:

${files.join("\n")}

QA REPORT:

${JSON.stringify(report, null, 2)}
`;

const messages = [
  {
    role: "system",
    content: systemPrompt
  },
  {
    role: "user",
    content:
      "Investigate the QA report and repair the reported issue. Use the available tools rather than merely explaining what should be done."
  }
];

let toolCalls = 0;

while (toolCalls < MAX_TOOL_CALLS) {
  const response =
    await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.1
    });

  const message = response.choices?.[0]?.message;

  if (!message) {
    throw new Error(
      "OpenRouter returned no message."
    );
  }

  messages.push(message);

  if (
    !message.tool_calls ||
    message.tool_calls.length === 0
  ) {
    console.log("\nAI FINAL RESPONSE:\n");
    console.log(message.content || "No response.");

    break;
  }

  for (const toolCall of message.tool_calls) {
    toolCalls++;

    const name = toolCall.function.name;

    let args;

    try {
      args = JSON.parse(
        toolCall.function.arguments || "{}"
      );
    } catch {
      args = {};
    }

    let result;

    try {
      if (name === "read_file") {
        result = readFile(args.path);
      }

      else if (name === "write_file") {
        result = writeFile(
          args.path,
          args.content
        );
      }

      else if (name === "run_command") {
        const allowedCommands = [
          ["npm", "test"],
          ["npm", "run", "build"],
          ["npm", "run", "verify:a11y"],
          ["npm", "run", "verify:game-sounds"],
          ["npm", "run", "verify:lobby-sounds"],
          ["npm", "run", "verify:mute-toggle"]
        ];

        const allowed = allowedCommands.some(
          allowedArgs =>
            args.command === allowedArgs[0] &&
            JSON.stringify(args.args) ===
              JSON.stringify(allowedArgs.slice(1))
        );

        if (!allowed) {
          throw new Error(
            "Command is not allowed."
          );
        }

        result = runCommand(
          args.command,
          args.args
        );
      }

      else {
        throw new Error(
          `Unknown tool: ${name}`
        );
      }
    } catch (error) {
      result = {
        error: error.message
      };
    }

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content:
        typeof result === "string"
          ? result
          : JSON.stringify(result)
    });
  }
}

if (toolCalls >= MAX_TOOL_CALLS) {
  console.log(
    "Maximum tool-call limit reached."
  );
}