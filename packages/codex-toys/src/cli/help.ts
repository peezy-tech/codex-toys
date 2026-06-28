export function helpText(): string {
	return `codex-toys controls Codex workspace runtime surfaces.

Usage:
  codex-toys fetch [--json] [--no-color]
  codex-toys neofetch [--json] [--no-color]
  codex-toys runtime serve [--cwd <path>]
  codex-toys runtime http [--cwd <path>] [--static <dir>] [--host <host>] [--port <port>]
  codex-toys mcp serve

  codex-toys --ssh <target> --cwd <remote-workspace> runtime preflight [--json]
  codex-toys runtime host-overview --json
  codex-toys --ssh <target> --cwd <remote-workspace> runtime host-overview --json

  codex-toys turn run <prompt> [--wait] [--thread-id <id>]
  codex-toys --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait

  codex-toys workflow list [--json]
  codex-toys workflow run <name> [--event <event.json>] [--prompt <text>] [--via workbench|app]
  codex-toys workflow run --script <path> [--event <event.json>] [--prompt <text>] [--via workbench|app]
  codex-toys workflow run --script-stdin [--event <event.json>] [--prompt <text>] [--via workbench|app]
  codex-toys --ssh <target> --cwd <remote-workspace> workflow list [--json]
  codex-toys --ssh <target> --cwd <remote-workspace> workflow run <name> [--event <event.json>]

  codex-toys app <method> [params-json]
  codex-toys app <method> --params-json <json>
  codex-toys app <method> --params-file <file>
  codex-toys app call <method> [params-json]
  echo '<params-json>' | codex-toys app <method>
  codex-toys app actions

  codex-toys functions list [--json]
  codex-toys functions describe <name> [--json]
  codex-toys functions call <name> [--params-json <json>] [--json]
  codex-toys --ssh <target> --cwd <remote-workspace> functions list [--json]

  codex-toys feed doctor [--mode auto|local|actions] [--json]
  codex-toys feed source list [--json]
  codex-toys feed poll [--source <source-id>] [--json]
  codex-toys feed item list [--source <source-id>] [--status new] [--json]
  codex-toys feed item read <item-id> [--json]
  codex-toys feed item append --source <source-id> --params-json <json> [--json]
  codex-toys feed collect [--cursor <name>] [--source <source-id>] [--limit <n>] [--no-advance] [--json]
  codex-toys feed cursor advance --cursor <name> --item <item-id> [--json]
  codex-toys feed dispatch --source <source-id> --cursor <name> --target workbench-task:<task-id> [--limit <n>] [--no-poll] [--json]
  codex-toys feed prune --older-than-days <days> [--dry-run]

  codex-toys workbench <method> [params-json]
  codex-toys workbench <method> --params-json <json>
  codex-toys workbench <method> --params-file <file>
  codex-toys workbench call <method> [params-json]
  codex-toys workbench app <method> [params-json]
  codex-toys workbench methods
  codex-toys workbench overview [--json]
  codex-toys workbench doctor [--mode auto|local|actions] [--json]
  codex-toys workbench run <task-id> [--mode auto|local|actions]
  codex-toys workbench prompt enqueue <prompt> [--run-at <iso>] [--after <intent-id>]
  codex-toys workbench prompt list [--queue <name>] [--status <status>] [--json]
  codex-toys workbench prompt pull <intent-id> [--json]
  codex-toys workbench prompt collect [--cursor <name>] [--queue <name>] [--json]
  codex-toys workbench prompt run-due [--queue <name>] [--limit <n>]
  codex-toys workbench handoff enqueue <prompt> [--target-host <host>] [--capability <name>]
  codex-toys workbench handoff list [--queue <name>] [--status <status>] [--json]
  codex-toys workbench handoff drain [--host-id <host>] [--capability <name>] [--materialize]
  codex-toys workbench dispatch create --params-json <json>
  codex-toys workbench dispatch list [--mode auto|local|actions] [--json]
  codex-toys workbench dispatch read <intent-id> [--include-output] [--json]
  codex-toys workbench dispatch collect [--cursor <name>] [--json]
  codex-toys workbench dispatch cancel <intent-id>
  codex-toys workbench dispatch retry <intent-id> [--run-at <iso>]
  codex-toys workbench dispatch run-due [--mode auto|local|actions]
  codex-toys workbench dispatch prune --older-than-days <days> [--dry-run]
  codex-toys workbench init actions [--forgejo|--github] [--image <ref>|--no-image]

  codex-toys actions prepare-auth
  codex-toys actions cleanup

  codex-toys memories transplant global-to-workbench [--apply]
  codex-toys memories transplant workbench-to-global [--apply]

  codex-toys threads locate <thread-id> [--codex-home <home>]
  codex-toys threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
  codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--cwd <path>] [--replace]
  codex-toys threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--cwd <path>] [--replace]

  codex-toys kit inspect <source> [--json]
  codex-toys kit add <source> [--apply] [--include <name>] [--exclude <name>]
  codex-toys kit setup <source> [--wait]
  codex-toys kit doctor [--json]
  codex-toys kit list [--json]

Options:
  --timeout-ms <ms>                          Request timeout. Defaults to 90000,
                                             1500 for local fetch probes, or
                                             1800000 for workflow run and
                                             waited turns.
  --compact                                  Print compact JSON.
  --pretty                                   Print pretty JSON.
  --json                                     Print JSON for supported commands.
  --no-color                                 Disable ANSI colors for fetch.
  --mode <auto|local|actions>                Workbench execution mode.
  --workbench-root <path>                    Workbench root. Defaults to discovery.
  --feed-root <path>                         Feed root. Defaults to discovery.
  --global-codex-home <path>                 Global Codex home for memories transplant.
  --workbench-codex-home <path>              Workbench Codex home for memories transplant.
  --codex-home <path>                        Codex home for thread transplant.
  --from-codex-home <path>                   Source Codex home for direct thread transplant.
  --to-codex-home <path>                     Target Codex home for direct thread transplant.
  --cwd <path>                               Runtime cwd, remote workspace cwd,
                                             or project cwd for thread state moves.
  --preserve-cwd                             Keep original thread cwd during transplant.
  --apply                                    Apply memory transplant changes.
  --overwrite                                Replace destination memory files after backup.
                                             For kit add, replace changed installed item dirs
                                             after backup under .codex/kit-backups.
  --replace                                  Replace an existing thread rollout after backup.
  --ref <ref>                                Git ref for non-local kit sources.
  --include <name>                           Include a kit item by name or kind:name.
  --exclude <name>                           Exclude a kit item by name or kind:name.
  --merge codex                              Merge MEMORY.md and memory_summary.md with Codex.
  --no-backup                                Disable overwrite/merge backups.
  --event <path>                             Event JSON for workflow, Actions,
                                             or workbench tasks.
  --script <path>                            Run a workflow module from a path.
  --script-stdin                             Read an inline workflow module from stdin.
  --forgejo                                  Generate a Forgejo Actions workflow.
  --github                                   Generate a GitHub Actions workflow.
  --image <ref>                              Use an Actions runner container image.
  --no-image                                 Generate setup-node/vp dlx Actions workflow.
  --prompt <text>                            Prompt text for workflow script context.
  --title <text>                             Queued prompt title.
  --queue <name>                             Prompt queue name.
  --label <label>                            Prompt queue label. Repeatable.
  --after <intent-id>                        Hold queued prompt until another intent finishes.
  --after-status <status>                    Dependency status: completed, failed,
                                             canceled, or terminal.
  --status <status>                          Dispatch/prompt status filter.
                                             Feed item list/collect supports new.
  --limit <n>                                Limit listed or due queued work.
  --run-at <iso>                             Future run time for dispatch or queued work.
  --service-tier <tier>                      Turn service tier for queued prompts.
  --effort <effort>                          Reasoning effort: none, minimal, low,
                                             medium, high, or xhigh.
  --target-cwd <path>                        Target cwd for queued prompt or handoff turns.
  --dry-run                                  Preview supported write operations.
  --older-than-days <days>                   Retention window for dispatch prune.
  --cursor <name>                            Dispatch collect cursor name.
                                             Feed collect also uses this cursor.
  --source <source-id>                       Feed source filter.
  --target <target>                          Feed dispatch target.
  --item <item-id>                           Feed item id for cursor advance.
  --static <dir>                             Static files for runtime http.
  --host <host>                              HTTP host for runtime http.
                                             Defaults to 127.0.0.1.
  --port <port>                              HTTP port for runtime http.
                                             Defaults to 3587.
  --no-advance                               Collect feed items without advancing cursor.
  --no-poll                                  Dispatch existing feed items without polling first.
  --via <workbench|app>                      Turn surface. Defaults to workbench.
  --sandbox <mode>                           Turn sandbox: danger-full-access,
                                             workspace-write, or read-only.
  --approval-policy <policy>                 Turn approval policy: never,
                                             on-failure, on-request, or untrusted.
  --permissions <profile>                    Turn permissions profile.
  --ssh, --ssh-target <target>               SSH target for runtime operation.
                                             Defaults to CODEX_TOYS_REMOTE_SSH_TARGET.
  --remote-path-prepend <paths>              Colon-separated remote PATH entries for
                                             non-interactive SSH commands.
  --runtime-command <command>                codex-toys command/path for spawned runtimes.
                                             Defaults to CODEX_TOYS_RUNTIME_COMMAND
                                             or codex-toys.
  --codex-command <command>                  Codex command used by the runtime.
                                             Defaults to CODEX_TOYS_REMOTE_CODEX_COMMAND or codex.
  --codex-arg <arg>                          Extra Codex argument. Repeatable.
  -h, --help                                 Show this help.

Examples:
  codex-toys fetch
  codex-toys mcp serve
  codex-toys runtime serve --cwd /repo
  codex-toys runtime http --cwd /repo --static ./dashboard
  codex-toys --ssh devbox --cwd /repo fetch
  codex-toys runtime host-overview --json
  codex-toys --ssh devbox --cwd /repo runtime host-overview --json
  codex-toys --ssh devbox --cwd /repo runtime preflight --json
  codex-toys --ssh devbox --cwd /repo turn run "Scan current folder" --wait
  codex-toys workflow list
  codex-toys workflow run check-release --event event.json
  codex-toys workflow run --script ./workflow.mjs --event event.json
  printf '%s\n' 'export default () => ({ status: "ok" })' | codex-toys workflow run --script-stdin
  codex-toys --ssh devbox --cwd /repo workflow list --json
  codex-toys --ssh devbox --cwd /repo workflow run check-release --event event.json
  codex-toys --ssh devbox --cwd /repo functions list --json
  codex-toys --ssh devbox --cwd /repo functions call accountSnapshot --json
  codex-toys feed poll --source openai-blog --json
  codex-toys feed item append --source hq-dispatch-results --params-json '{"externalId":"run-123","title":"Dispatch result","raw":{"status":"completed"}}' --json
  codex-toys feed collect --cursor radar --json
  codex-toys feed dispatch --source cli-utility-releases --cursor cli-toys-bindings-refresh --target workbench-task:cli-toys-bindings-refresh --json
  codex-toys --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-toys app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-toys workbench app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-toys workbench overview --json
  codex-toys workbench doctor --mode actions
  codex-toys workbench dispatch create --params-json '{"runAt":"2026-01-01T14:00:00.000Z","target":{"kind":"turn","prompt":"Review the workbench."}}'
  codex-toys workbench init actions --forgejo
  codex-toys memories transplant global-to-workbench
  codex-toys threads inspect 019e3654-1492-70d0-9b01-46b17d6444a9 --codex-home ./.codex
  codex-toys threads install-rollout ./rollout-2026-05-18T15-12-25-019e3ba5-3c2a-74c1-bece-53a8ece3dc0e.jsonl --codex-home ~/.codex --cwd "$PWD"
  codex-toys threads transplant 019e3654-1492-70d0-9b01-46b17d6444a9 --from-codex-home ./.codex --to-codex-home ~/.codex --cwd "$PWD"
  codex-toys kit inspect owner/repo
  codex-toys kit add ./capability-kit --apply
`;
}
