import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/** Stores signed Anthropic `thinking`/`redacted_thinking` blocks per assistant turn,
 *  keyed by conversation id, so a multi-turn reasoning loop on the Anthropic wire can
 *  re-inject them on the next request — the OpenAI chat wire drops reasoning, so the
 *  translator can't carry it alone. One object per conversation (idFromName).
 *
 *  WHY: an Anthropic-shape client driving an OpenAI-shape upstream loses the signed
 *  thinking block; reasoning models reject a continuation that omits the prior signed
 *  thinking. The DO is the proxy-side memory that closes that gap.
 *
 *  Engaged ONLY for reasoning-capable openai_chat upstreams on the Anthropic wire;
 *  native-anthropic upstreams pass thinking through themselves (the DO is a no-op). */

export interface ThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  data?: string;
  signature?: string;
}

interface Turn {
  model: string;
  blocks: ThinkingBlock[];
  at: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;

export class ThinkingSessionDO extends DurableObject<Env> {
  /** Append a turn's signed thinking blocks. */
  async saveAssistantTurn(req: {
    conversationId: string;
    model: string;
    blocks: ThinkingBlock[];
  }): Promise<void> {
    if (!req.blocks.length) return;
    const turns = (await this.ctx.storage.get<Turn[]>("turns")) ?? [];
    turns.push({ model: req.model, blocks: req.blocks, at: Date.now() });
    // bound growth — keep the last 32 turns
    const trimmed = turns.slice(-32);
    await this.ctx.storage.put("turns", trimmed);
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  /** Return prior signed thinking blocks for a model (most-recent-first chain). */
  async loadPriorThinking(req: { conversationId: string; model: string }): Promise<ThinkingBlock[]> {
    const turns = (await this.ctx.storage.get<Turn[]>("turns")) ?? [];
    const out: ThinkingBlock[] = [];
    for (const t of turns) {
      if (t.model === req.model) out.push(...t.blocks);
    }
    return out;
  }


  async alarm(): Promise<void> {
    const turns = (await this.ctx.storage.get<Turn[]>("turns")) ?? [];
    const cutoff = Date.now() - TTL_MS;
    const live = turns.filter((t) => t.at >= cutoff);
    if (live.length === turns.length) {
      await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
      return;
    }
    if (live.length) {
      await this.ctx.storage.put("turns", live);
      await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
    } else {
      await this.ctx.storage.delete("turns");
    }
  }
}
