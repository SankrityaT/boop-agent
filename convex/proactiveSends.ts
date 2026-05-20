import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

export const record = mutation({
  args: {
    userPhone: v.string(),
    conversationId: v.string(),
    triggerKind: v.string(),
    triggerRef: v.optional(v.string()),
    messageContent: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("proactiveSends", {
      ...args,
      sentAt: Date.now(),
    });
  },
});

export const lastSentAt = query({
  args: { userPhone: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("proactiveSends")
      .withIndex("by_user_sent", (q) => q.eq("userPhone", args.userPhone))
      .order("desc")
      .first();
    return row?.sentAt ?? null;
  },
});

// Returns proactive sends from the last `sinceMs` milliseconds for the given
// user. The engine uses this to dedup ("don't ping again about a draft I
// already mentioned in the last 24h") and for analytics.
export const recentSends = query({
  args: { userPhone: v.string(), sinceMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.sinceMs;
    const rows = await ctx.db
      .query("proactiveSends")
      .withIndex("by_user_sent", (q) =>
        q.eq("userPhone", args.userPhone).gte("sentAt", cutoff),
      )
      .order("desc")
      .take(50);
    return rows;
  },
});
