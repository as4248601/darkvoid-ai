module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const now = Date.now();
    const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();
    const bucket = global.__darkvoidRateLimit || (global.__darkvoidRateLimit = new Map());
    const prior = bucket.get(ip);
    if (prior && now - prior.started < 60000 && prior.count >= 20) {
      return res.status(429).json({ error: "rate_limited" });
    }
    bucket.set(ip, !prior || now - prior.started >= 60000 ? { started: now, count: 1 } : { started: prior.started, count: prior.count + 1 });
    if (bucket.size > 500) {
      for (const [key, value] of bucket) if (now - value.started >= 60000) bucket.delete(key);
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const provider = ["auto", "claude", "openai"].includes(body.provider) ? body.provider : "auto";
    const system = typeof body.system === "string" ? body.system.slice(0, 5000) : "";
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20).map(m => ({
      role: m && m.role === "assistant" ? "assistant" : "user",
      content: typeof (m && m.content) === "string" ? m.content.slice(0, 5000) : ""
    })).filter(m => m.content) : [];

    if (!system || !messages.length || messages[messages.length - 1].role !== "user") {
      return res.status(400).json({ error: "invalid_request" });
    }
    if (messages.reduce((n, m) => n + m.content.length, system.length) > 18000) {
      return res.status(413).json({ error: "request_too_large" });
    }

    const candidates = provider === "auto" ? ["claude", "openai"] : [provider];
    const failures = [];
    for (const engine of candidates) {
      const key = engine === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
      if (!key) {
        failures.push(engine + "_key_missing");
        continue;
      }
      try {
        let text = "";
        let model = "";
        if (engine === "claude") {
          model = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
          const upstream = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
              model,
              max_tokens: 900,
              system,
              messages: messages.map(m => ({ role: m.role, content: m.content }))
            })
          });
          const data = await upstream.json().catch(() => ({}));
          if (!upstream.ok) throw new Error("claude_upstream_" + upstream.status);
          text = (data.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
        } else {
          model = process.env.OPENAI_MODEL || "gpt-6.1-sol";
          const input = [{ role: "system", content: system }, ...messages];
          const upstream = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "authorization": "Bearer " + key
            },
            body: JSON.stringify({ model, input, max_output_tokens: 900 })
          });
          const data = await upstream.json().catch(() => ({}));
          if (!upstream.ok) throw new Error("openai_upstream_" + upstream.status);
          text = (data.output || []).flatMap(item => item.content || [])
            .filter(item => item.type === "output_text").map(item => item.text).join("\n").trim();
        }
        if (!text) throw new Error(engine + "_empty_response");
        return res.status(200).json({ text, provider: engine, model });
      } catch (error) {
        failures.push(engine + "_failed");
      }
    }

    const configured = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
    return res.status(configured ? 502 : 503).json({
      error: configured ? "provider_failed" : "not_configured",
      availableProviders: {
        claude: Boolean(process.env.ANTHROPIC_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY)
      }
    });
  } catch (error) {
    return res.status(500).json({ error: "server_error" });
  }
};
