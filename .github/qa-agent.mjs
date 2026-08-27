import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});

const MODEL = "openrouter/free";
const REPORT_PATH = "qa/reports/qa-report.json";

const protectedPaths = [
  ".env",
  ".env.local",
  ".env.production",
  ".github/workflows/",
  "supabase/migrations/",
  "node_modules/",
  ".git/"
];

function isProtected(filePath) {
  const normalized = filePath.replaceAll("\\", "/");

  return protectedPaths.some(
    protectedPath =>
      normalized === protectedPath ||
      normalized.startsWith(protectedPath)
  );
}

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  if (isProtected(filePath)) {
    throw new Error(`Protected file cannot be edited: ${filePath}`);
  }

  const stats = fs.statSync(filePath);

  if (stats.size > 500_000) {
    throw new Error(`File is too large to edit: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8");
}

function writeFile(filePath, content) {
  if (isProtected(filePath)) {
    throw new Error(`Protected file cannot be edited: ${filePath}`);
  }

  if (path.isAbsolute(filePath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const normalized = path.normalize(filePath);

  if (normalized.startsWith("..")) {
    throw new Error("Path traversal is not allowed.");
  }

  fs.writeFileSync(filePath, content, "utf8");

  console.log(`Modified: ${filePath}`);
}

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is missing.");
}

if (!fs.existsSync(REPORT_PATH)) {
  throw new Error(`QA report does not exist: ${REPORT_PATH}`);
}

const report = JSON.parse(
  fs.readFileSync(REPORT_PATH, "utf8")
);

const reportText = JSON.stringify(report, null, 2);

if (!report.errors || report.errors.length === 0) {
  console.log("QA report contains no errors.");
  process.exit(0);
}

const prompt = `
You are the autonomous QA repair agent for the Grynd skill-based PvP gaming application.

Repository:
Hahuyphananh/Casino-app

Technology:
- Next.js
- React
- JavaScript/TypeScript
- Supabase
- Clerk
- Socket.io
- Drizzle

A QA run detected the following errors:

${reportText}

Your task is to identify the smallest safe code change that fixes the reported problem.

IMPORTANT:

1. Fix ONLY the concrete QA problem.
2. Do not redesign the application.
3. Do not change game mechanics unless required by the reported bug.
4. Do not modify authentication.
5. Do not modify Supabase RLS.
6. Do not modify payment logic.
7. Do not modify wallet/balance logic unless directly required.
8. Do not modify environment variables or secrets.
9. Do not modify GitHub Actions workflows.
10. Do not modify package versions.
11. Do not delete tests.
12. Do not disable tests.
13. Do not remove security checks.
14. Do not make unrelated improvements.
15. If you cannot confidently determine a safe fix, do not make any changes.
16. Read files before editing them.
17. Make the smallest possible change.
18. Preserve the existing UI and game behavior.
`;

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a repository source file before deciding whether it needs to be changed.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative repository file path."
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
        "Replace the complete contents of a repository source file with corrected contents.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative repository file path."
          },
          content: {
            type: "string",
            description: "Complete corrected file contents."
          }
        },
        required: ["path", "content"]
      }
    }
  }
];

const messages = [
  {
    role: "system",
    content:
      "You are a cautious autonomous software maintenance agent. Use read_file before write_file. Make minimal evidence-based changes only."
  },
  {
    role: "user",
    content: prompt
  }
];

let changedFiles = new Set();

for (let iteration = 0; iteration < 8; iteration++) {
  console.log(`AI iteration ${iteration + 1}/8`);

  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    temperature: 0.1
  });

  const message = response.choices?.[0]?.message;

  if (!message) {
    throw new Error("OpenRouter returned no message.");
  }

  messages.push(message);

  if (message.content) {
    console.log("AI:", message.content);
  }

  const toolCalls = message.tool_calls || [];

  if (toolCalls.length === 0) {
    console.log("AI finished without requesting another edit.");
    break;
  }

  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name;

    let args;

    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new Error(`Invalid tool arguments returned by AI.`);
    }

    let result;

    try {
      if (name === "read_file") {
        result = readFile(args.path);
      } else if (name === "write_file") {
        writeFile(args.path, args.content);
        changedFiles.add(args.path);
        result = `Successfully modified ${args.path}.`;
      } else {
        result = `Unknown tool: ${name}`;
      }
    } catch (error) {
      result = `ERROR: ${error.message}`;
    }

    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: result
    });
  }
}

console.log("");
console.log("===== AI FIX SUMMARY =====");

if (changedFiles.size === 0) {
  console.log("No files were modified.");
} else {
  for (const file of changedFiles) {
    console.log(`Changed: ${file}`);
  }
}
