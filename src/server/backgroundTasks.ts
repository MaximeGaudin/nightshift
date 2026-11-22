// Background commands an agent process started and that have not ended yet, read from its stream-json events.
//
// `claude -p` keeps its process alive while a background command runs, and starts a new turn (with a new result)
// when the command ends, so a command still open when the process exits is the unusual case this guards against.
// Verified against claude CLI 2.x (test/fixtures/stream-background.jsonl):
// - start: `system/task_started` with the Bash `tool_use_id` and `is_backgrounded: true`; the Bash tool_result
//   carries `tool_use_result.backgroundTaskId` and says "Command running in background with ID: <id>" (or
//   "moved to the background (ID: <id>)" when a foreground call outlived its timeout);
// - end: `system/task_notification` (any status), `system/task_updated` to a final status, or a
//   `system/background_tasks_changed` list that no longer holds the task. Older CLIs only inject a user message
//   holding `<task-notification><task-id>…</task-id>`, which is read too.
// Only the card's own Bash calls count: a subagent's tool_use carries `parent_tool_use_id` and is never tracked.

const STARTED = /(?:running in background with ID: |moved to the background \(ID: )([A-Za-z0-9_-]+)/;
const NOTIFIED = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/g;
const FINAL = new Set(["completed", "failed", "killed", "stopped", "cancelled", "error"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Text of a message content: a plain string, or the text of its text/tool_result blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isObj(b) ? (str(b.text) ?? (b.type === "tool_result" ? textOf(b.content) : "")) : "")).join("\n");
}

export class BackgroundTasks {
  /** The card's own Bash calls: tool_use id -> command. */
  private readonly bash = new Map<string, string>();
  /** Background commands still running: task id -> command. */
  private readonly running = new Map<string, string>();

  /** Commands started in the background and not ended yet, in start order. */
  openCommands(): string[] {
    return [...this.running.values()];
  }

  onEvent(ev: unknown): void {
    if (!isObj(ev)) return;
    const own = !ev.parent_tool_use_id;
    const message = isObj(ev.message) ? ev.message : undefined;
    if (ev.type === "assistant" && own && Array.isArray(message?.content)) {
      for (const b of message.content) {
        if (!isObj(b) || b.type !== "tool_use" || b.name !== "Bash" || typeof b.id !== "string") continue;
        const input = isObj(b.input) ? b.input : {};
        this.bash.set(b.id, str(input.command) ?? str(input.description) ?? "Bash command");
      }
    } else if (ev.type === "user") {
      const content = message?.content;
      if (own && Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const command = this.bash.get(b.tool_use_id);
          if (command === undefined) continue;
          const meta = isObj(ev.tool_use_result) ? ev.tool_use_result : undefined;
          const id = str(meta?.backgroundTaskId) ?? STARTED.exec(textOf(b.content))?.[1];
          if (id) this.running.set(id, command);
        }
      }
      for (const m of textOf(content).matchAll(NOTIFIED)) this.running.delete(m[1] as string);
    } else if (ev.type === "system") {
      const taskId = str(ev.task_id);
      if (ev.subtype === "task_started" && taskId && ev.is_backgrounded !== false) {
        const command = this.bash.get(str(ev.tool_use_id) ?? "");
        if (command !== undefined) this.running.set(taskId, command);
      } else if (ev.subtype === "task_notification" && taskId) {
        this.running.delete(taskId);
      } else if (ev.subtype === "task_updated" && taskId) {
        const status = isObj(ev.patch) ? str(ev.patch.status) : undefined;
        if (status && FINAL.has(status)) this.running.delete(taskId);
      } else if (ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
        const live = new Set(ev.tasks.map((t) => (isObj(t) ? str(t.task_id) : undefined)));
        for (const id of [...this.running.keys()]) if (!live.has(id)) this.running.delete(id);
      }
    }
  }
}
