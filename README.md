# dsh-taste-loop

Taste-loop plugin for DeepSeek Harness (DSH, host-only): a self-service **taste protocol** for domain agents — record judgments, propose versioned rule revisions, and reach independent-session quorum consensus, with human arbitration for disputes.

## Tools

| Tool | Purpose |
|---|---|
| `taste_rules` | Registered rules + proposal states (effective / pending_review / needs_arbitration) |
| `taste_case` | Deterministic case ID — the same judgment point always maps to the same ID |
| `taste_record` | Record a taste judgment into the verifier inbox |
| `taste_queue` | Snapshot of the human arbitration / settlement queue |
| `taste_update` | Self-service rule lifecycle: `propose / list / blind / endorse / resolve` |

## Self-service rule lifecycle

1. Any domain agent creates or revises a **versioned rule proposal** (`taste_update propose`). History is append-only JSONL; nothing auto-activates.
2. Two **independent DSH sessions** (distinct from the proposal author; `ctx=decision:` contexts never count) endorse the same revision → it becomes the domain's `effective` version. Consensus `effective` and human `ratified` are always reported separately.
3. Two independent dissenting sessions → `needs_arbitration`. The previous effective version stays in force while the dispute is frozen.
4. A human arbiter (see `arbiterSessionIds`) resolves the dispute; every resolution appends a claim and a resolution row.

**Security boundary:** direct HTTP callers with only a self-reported `X-Market-Client` header may write ordinary judgments, but can **never** propose shared rules, endorse, or resolve. The workbench-market gateway can be trusted via a shared `marketGatewayKey` (config on both sides): requests carrying a matching `X-Market-Gateway-Key` upgrade the gateway session identity `mcp/<name>` to a verified `market/<name>` session, which may propose and endorse. Human arbitration (`resolve`) stays restricted to configured DSH `arbiterSessionIds`. Proposal/endorsement/resolution ledgers are serialized with crash-recoverable file locks.

## Install

From a local checkout (recommended for now):

```bash
dsh plugin --profile web add /path/to/dsh-taste-loop
```

From GitHub source: the `prepare` script builds `lib/`, but `@deepseek-ai/*` peers resolve only inside a DSH profile — a standalone `pnpm add github:NelsonLongxiang/dsh-taste-loop` outside a DSH profile may fail typecheck.

## Configuration (`cordis.patch.yml`)

```yaml
- id: taste-loop
  config:
    verifierRepo: 'D:path	oerifier-repo'   # required
    inboxHome: 'D:path	oinbox'              # optional
    host: 127.0.0.1                            # taste-mcp HTTP face
    port: 9810
    arbiterSessionIds: []                      # DSH session IDs allowed to resolve disputes
    marketGatewayKey: ''                       # shared secret with the market gateway; set to enable trusted market sessions
```

## Development

```bash
pnpm install && pnpm build && pnpm verify && pnpm drift
```

## License

[MIT](./LICENSE)
