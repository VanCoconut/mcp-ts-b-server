// src/server.ts
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import morgan from "morgan";
import fetch from "node-fetch";

// Config
const PORT = Number(process.env.PORT ?? 3000);

// 1) Crea server MCP
const server = new McpServer({ name: "mcp-server", version: "1.0.0" });

// 2) Tool get_weather
const getWeather = server.tool(
    "get_weather",
    "A tool to get the weather of a city. Does not need any authentication.",
    { city: z.string().describe("Name of the city to get the weather for") },
    async ({ city }, _extra) => {
        const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Weather API error: ${resp.status} - ${txt}`);
        }
        const weatherText = await resp.text();
        return {
            content: [{ type: "text", text: `Weather for ${city}: ${weatherText}` }],
        };
    }
);

// Tool: get_exchange_rate
const getExchangeRate = server.tool(
    "get_exchange_rate",
    "A tool to get current exchange rate between two currencies. No authentication required.",
    {
        from: z.string().describe("Base currency code, e.g., 'EUR'"),
        to: z.string().describe("Target currency code, e.g., 'USD'"),
    },
    async ({ from, to }, _extra) => {
        const resp = await fetch(`https://www.floatrates.com/daily/${from.toLowerCase()}.json`);
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Exchange rate API error: ${resp.status} - ${txt}`);
        }
        const rates = await resp.json();
        // @ts-ignore
        const rate = rates[to.toLowerCase()]?.rate;
        if (!rate) throw new Error(`No rate found for ${from} -> ${to}`);
        return {
            content: [
                { type: "text", text: `1 ${from.toUpperCase()} = ${rate} ${to.toUpperCase()}` }
            ]
        };
    }
);

// 3) Transport
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
server.connect(transport).then(() => console.log("MCP server connected"));

// 4) Express app
const app = express();
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

// 5) Endpoint per invocare tool (senza auth)
// src/server.ts
app.post("/invoke-tool", async (req: Request, res: Response) => {
    try {
        const { tool, args } = req.body;
        if (!tool) return res.status(400).json({ ok: false, error: "Missing 'tool' in body" });

        // costruisci payload JSON-RPC come MCP client
        const rpcPayload = {
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                name: tool,
                arguments: args ?? {},
                _meta: { progressToken: 0 }
            },
            id: "1"
        };

        // usa il transport del server per gestire la richiesta
        const fakeReq = {
            body: rpcPayload,
            headers: {},
            method: "POST",
            path: "/mcp"
        } as any;

        const fakeRes = {
            json: (data: any) => res.json(data),
            status: (code: number) => { res.status(code); return fakeRes; },
            headersSent: false
        } as any;

        await transport.handleRequest(fakeReq, fakeRes, rpcPayload);

    } catch (err: any) {
        console.error("Error invoking tool:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});


// 6) Endpoint MCP "puro" (per eventuali client MCP)
app.post("/mcp", async (req: Request, res: Response) => {
    try {
        await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
        console.error("Error handling MCP request:", err);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
    }
});

// 7) Avvio server
app.listen(PORT, () => console.log(`MCP server listening on http://localhost:${PORT}`));
