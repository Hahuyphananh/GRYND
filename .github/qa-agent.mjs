import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import OpenAI from "openai";

const MAX_AI_ATTEMPTS = 2;

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});

const model = "openrouter/free";

function run(command, args = []) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
}

function getFiles(dir, result = [], root = dir) {
  const entries = fs.readdirSync(dir, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full);

    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".next" ||
      entry.name === "dist" ||
      entry.name === "build"
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      getFiles(full, result, root);
      continue;
    }

    if (
      relative.endsWith(".js") ||
      relative.endsWith(".jsx") ||
      relative.endsWith(".ts") ||
      relative.endsWith(".tsx") ||
      relative.endsWith(".mjs") ||
      relative.endsWith(".json") ||
      relative.endsWith(".css")
    ) {
      result.push(relative);
    }
  }

  return result;
}

function isExpectedError(error) {
  const text = JSON.stringify(error).toLowerCase();

  // Expected authentication failures from protected APIs.
  if (
    text.includes('"status":401') ||
    text.includes("401 unauthorized") ||
    text.includes("unauthorized")
  ) {
    return true;
  }

  // Known third-party Tawk.to browser errors.
  if (
    text.includes("tawk.to") ||
    text.includes("embed.tawk.to")
  ) {
    return true;
  }

  return false;
}

const reportPath = "qa/reports/qa-report.json";

if (!fs.existsSync(reportPath)) {
  console.log("No QA report found. Nothing for AI to analyze.");
  process.exit(0);
}

let report;

try {
  report = JSON.parse(
    fs.readFileSync(reportPath, "utf8")
  );
} catch (error) {
  throw new Error(
    `Could not read QA report: ${error.message}`
  );
}

const originalErrors = Array.isArray(report.errors)
  ? report.errors
  : [];

const actionableErrors = originalErrors.filter(
  error => !isExpectedError(error)
);

if (originalErrors.length > 0) {
  console.log(`Total QA errors: ${originalErrors.length}`);
  console.log(`Actionable errors: ${actionableErrors.length}`);
}

if (actionableErrors.length === 0) {
  console.log(
    "No actionable application errors were detected."
  );
  console.log(
    "Skipping AI repair because the detected errors are expected or third-party."
  );
  process.exit(0);
}

const files = getFiles(".");

const fileList = files.slice(0, 500);

const actionableReport = {
  ...report,
  errors: actionableErrors
};

const prompt = `
You are the autonomous QA repair agent for the GRYND skill-based PvP gaming application.

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
- Vercel deployment

Your job is to fix ONLY concrete application problems identified by the QA report.

IMPORTANT:

1. Do NOT redesign the application.
2. Do NOT change game mechanics unless the reported error explicitly requires it.
3. Do NOT modify authentication architecture.
4. Do NOT modify Supabase RLS policies.
5. Do NOT modify payment logic.
6. Do NOT modify wallet/balance logic unless the reported bug specifically requires it.
7. Do NOT remove security checks.
8. Do NOT disable tests.
9. Do NOT delete tests.
10. Do NOT remove error handling just to make tests pass.
11. Do NOT modify environment secrets.
12. Do NOT modify package versions unless absolutely necessary.
13. Do NOT modify GitHub Actions workflows.
14. Do NOT modify files inside .github/workflows.
15. Do NOT modify Supabase migrations.
16. Make the smallest possible fix.
17. Preserve existing UI and game behavior.
18. Only change files directly related to the reported problem.
19. If you cannot confidently identify a safe fix, make NO changes.
20. Do not create fake fixes just to make the QA test pass.

EXPECTED/IGNORED ERRORS:

The QA system has already filtered out expected authentication failures and known third-party Tawk.to errors.

Only the remaining errors below should be investigated.

QA REPORT:

${JSON.stringify(actionableReport, null, 2)}

AVAILABLE SOURCE FILES:

${fileList.join("\n")}

PROCESS:

1. Inspect the relevant source files.
2. Identify the root cause.
3. Make the smallest safe correction.
4. Do not modify unrelated files.
5. Do not merely describe the solution.
6. Actually modify the repository files.
7. Stop if there is no safe fix.

Remember: a correct NO-CHANGE decision is better than an unsafe change.
`;

let lastAnswer = "";

for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
  console.log("");
  console.log(`AI iteration ${attempt}/${MAX_AI_ATTEMPTS}`);

  try {
    const response =
      await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a careful autonomous software maintenance agent. Make minimal, evidence-based fixes. Never invent changes."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1
      });

    const answer =
      response.choices?.[0]?.message?.content || "";

    lastAnswer = answer;

    console.log("AI:");
    console.log(answer);

    if (!answer) {
      console.log("AI returned an empty response.");
      break;
    }

    // One successful AI response is enough.
    break;
  } catch (error) {
    if (
      error?.status === 429 ||
      error?.code === 429 ||
      String(error?.message || "")
        .toLowerCase()
        .includes("rate limit")
    ) {
      console.log("");
      console.log(
        "OpenRouter rate limit reached."
      );
      console.log(
        "The AI repair was stopped safely."
      );
      console.log(
        "No automated fix PR will be created from this run."
      );

      process.exit(0);
    }

    console.error("");
    console.error("AI request failed:");
    console.error(error);

    if (attempt === MAX_AI_ATTEMPTS) {
      throw error;
    }
  }
}

if (!lastAnswer) {
  console.log(
    "AI did not produce a repair response."
  );
  process.exit(0);
}

console.log("");
console.log("Checking whether the AI changed the repository...");

let status = "";

try {
  status = run("git", [
    "status",
    "--porcelain"
  ]).trim();
} catch (error) {
  console.error(
    `Could not check git status: ${error.message}`
  );
  process.exit(0);
}

if (!status) {
  console.log(
    "AI made no repository changes."
  );
  console.log(
    "No automated fix PR will be created."
  );
  process.exit(0);
}

console.log("");
console.log("AI changed:");
console.log(status);

console.log("");
console.log(
  "AI changes detected. The workflow will now run tests, build, and browser QA."
);
