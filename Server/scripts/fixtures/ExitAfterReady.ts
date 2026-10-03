Bun.serve({ hostname: "127.0.0.1", port: Number(Bun.env.SERVER_PORT), fetch: request => {
  if (new URL(request.url).pathname === "/health") setTimeout(() => process.exit(24), 100);
  return Response.json({ status: "ok" });
} });
