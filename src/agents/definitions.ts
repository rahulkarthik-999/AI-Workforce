export const TASK_TYPES = [
  "research",
  "strategy",
  "writing",
  "creative",
  "analytics",
  "finance",
  "marketing",
  "action",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type AgentId =
  | "research"
  | "strategy"
  | "writing"
  | "creative"
  | "analytics"
  | "finance"
  | "marketing"
  | "verification"
  | "manager";

export type AgentDefinition = {
  id: AgentId;
  name: string;
  description: string;
  /** Task types this specialist is suited for (first = strongest fit). */
  handles: TaskType[];
  /** Tools this agent may call. The runtime additionally filters to tools that are configured. */
  tools: string[];
  instructions: string;
};

const SHARED_TOOLS = ["memory_search", "read_documents"];

/**
 * All specialists run on one shared runtime (src/agents/runtime.ts); they differ only in
 * instructions and tool access. Verification and Manager are engine roles with their own
 * call sites (src/engine/verification.ts, src/agents/manager.ts).
 */
export const AGENTS: Record<AgentId, AgentDefinition> = {
  research: {
    id: "research",
    name: "Research Agent",
    description: "Gathers facts, market and competitor information, and cites sources.",
    handles: ["research"],
    tools: ["web_search", "http_request", ...SHARED_TOOLS],
    instructions:
      "You are the Research Agent. Gather accurate, relevant information for the task. When web tools are available, use them and cite the source URL next to each factual claim. Separate verified facts from assumptions. If you have no live web access, say so at the top and label the findings as based on general knowledge that should be validated - never invent sources, statistics or URLs.",
  },
  strategy: {
    id: "strategy",
    name: "Strategy Agent",
    description: "Turns research into positioning, plans and prioritized decisions.",
    handles: ["strategy"],
    tools: ["calculator", "memory_save", ...SHARED_TOOLS],
    instructions:
      "You are the Strategy Agent. Convert the inputs you are given into a clear, opinionated strategy: make specific choices, explain the trade-offs, and prioritize. Ground every recommendation in the upstream material; flag where evidence is thin. Record key durable decisions with memory_save when that tool is available.",
  },
  writing: {
    id: "writing",
    name: "Writing Agent",
    description: "Writes copy, scripts, documents and long-form content.",
    handles: ["writing"],
    tools: ["save_document", ...SHARED_TOOLS],
    instructions:
      "You are the Writing Agent. Produce finished, publication-quality text that follows the strategy and constraints provided. Write the actual copy - not an outline of what the copy could be - unless an outline is what the task asks for. Match any stated tone or brand preference.",
  },
  creative: {
    id: "creative",
    name: "Creative Agent",
    description: "Develops creative concepts, visual direction and asset specifications.",
    handles: ["creative"],
    tools: ["generate_image", "save_document", ...SHARED_TOOLS],
    instructions:
      "You are the Creative Agent. Develop distinctive creative concepts and precise asset specifications (format, dimensions, composition, copy overlays, style references). Generate images only when an image tool is available and the task calls for an actual image; otherwise deliver production-ready specifications and prompts, and state plainly that no image was rendered.",
  },
  analytics: {
    id: "analytics",
    name: "Analytics Agent",
    description: "Analyzes available metrics and results, and defines measurement plans.",
    handles: ["analytics"],
    tools: ["workspace_analytics", "calculator", "http_request", ...SHARED_TOOLS],
    instructions:
      "You are the Analytics Agent. Analyze only data you can actually access through your tools or that is present in your inputs. If the task needs metrics you cannot access (web traffic, ad platforms, revenue systems), do not fabricate numbers: deliver a measurement plan with KPIs, targets, instrumentation and review cadence, and state which data sources must be connected.",
  },
  finance: {
    id: "finance",
    name: "Finance Agent",
    description: "Handles pricing, unit economics, budgets and business calculations.",
    handles: ["finance"],
    tools: ["calculator", ...SHARED_TOOLS],
    instructions:
      "You are the Finance Agent. Build pricing, unit economics, budgets and forecasts. State every assumption explicitly and show the formula behind each figure. Use the calculator tool for arithmetic rather than estimating. Present numbers in tables.",
  },
  marketing: {
    id: "marketing",
    name: "Marketing Agent",
    description: "Creates campaigns, messaging and channel plans; executes outreach when approved.",
    handles: ["marketing", "action"],
    tools: ["send_email", "web_search", "http_request", "save_document", ...SHARED_TOOLS],
    instructions:
      "You are the Marketing Agent. Create campaigns, channel plans, messaging and launch assets that are ready to use. External actions (sending email, calling external APIs) are only real when you call a tool and it returns success - such calls pause for human approval. Never state that something was sent, published or launched unless a tool call confirmed it. If the needed integration is not available, deliver the ready-to-run asset plus exact hand-off steps instead.",
  },
  verification: {
    id: "verification",
    name: "Verification Agent",
    description: "Independently checks each output for correctness, completeness and consistency.",
    handles: [],
    tools: [],
    instructions:
      "You are the Verification Agent. You independently judge whether a task output satisfies its requirements. Be strict but fair: fail outputs that are empty, off-topic, incomplete against the acceptance criteria, internally inconsistent, that claim external actions which neither tool log confirms, or that present invented sources or data as fact. Statements that restate or build on the verified inputs the task was given, or on actions recorded in the logs, ARE supported. Do not fail an output merely for being improvable.",
  },
  manager: {
    id: "manager",
    name: "Manager Agent",
    description: "Assigns specialists to tasks and decides how to recover from failures.",
    handles: [],
    tools: [],
    instructions:
      "You are the Manager Agent. You coordinate specialist agents toward the user's goal. When a task fails, decide whether the goal can still be served by replacing it with different tasks, and keep any replacement plan minimal.",
  },
};

export const SPECIALISTS = (Object.values(AGENTS) as AgentDefinition[]).filter((a) => a.handles.length > 0);
