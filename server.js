import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import jsforce from "jsforce";
import { z } from "zod";

const server = new McpServer({ name: "salesforce-mcp", version: "1.0.0" });

const SF_USERNAME = "shreyash7@agentforce.com";
const SF_PASSWORD = "cloud#777jCJkmNicrRXkwLBWSIF9gDEb";
const OPENAI_API_KEY = "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";
const SF_BASE_URL = "https://orgfarm-3e0de8e3bc-dev-ed.develop.my.salesforce.com";

async function getSFConn() {
  const conn = new jsforce.Connection({ loginUrl: "https://login.salesforce.com" });
  await conn.login(SF_USERNAME, SF_PASSWORD);
  return conn;
}

// ── GPT helper ───────────────────────────────────────────────────
async function gptCall(systemPrompt, userPrompt) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  const data = await response.json();
  if (!data.output || !data.output[0]) throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
  return data.output[0].content[0].text.trim();
}

// ── Step 1: Detect objects from question using GPT ───────────────
async function detectObjects(question, allObjects) {
  const text = await gptCall(
    `You are a Salesforce expert. Given a user question, identify which Salesforce object API names are needed to answer it.
Available objects: ${JSON.stringify(allObjects)}

Rules:
- Return ONLY a JSON array of object API names e.g. ["Account"] or ["Case","Contact"]
- No explanation, no markdown, just the raw JSON array
- Pick the most relevant objects based on the question
- If question mentions cases/tickets → Case
- If question mentions contacts/people → Contact
- If question mentions accounts/companies → Account
- If question mentions opportunities/deals → Opportunity
- If question mentions leads/prospects → Lead
- Always include related objects too (e.g. if user asks for contact name on case → include both Case and Contact)`,
    question
  );
  try { return JSON.parse(text); } catch { return ["Account"]; }
}

// ── Step 2: Generate SOQL from question + real schema ────────────
async function generateSOQL(question, schemas) {
  return await gptCall(
    `You are a Salesforce SOQL expert. Generate a valid SOQL query based on the user question and the REAL Salesforce schema provided below.

REAL SCHEMA FROM THIS ORG:
${JSON.stringify(schemas, null, 2)}

STRICT RULES:
- Return ONLY the raw SOQL query, nothing else. No markdown, no backticks, no explanation.
- ONLY use field names that EXIST in the schema above. Never guess or invent field names.
- Always include Id in SELECT

QUERY TYPE RULES:
- If user asks "how many" with NO request for details → use SELECT COUNT() FROM Object WHERE ...  (no LIMIT)
- If user asks "how many" AND wants details like names/numbers → fetch actual records with all requested fields, LIMIT 50
- All other questions → SELECT actual fields, LIMIT 50

FIELD RULES:
- "case number" → CaseNumber
- "case link" or "url" → include Id, the app builds the URL as: ${SF_BASE_URL}/lightning/r/Case/{Id}/view
- "contact name" on Case → Contact.Name
- "account name" → Account.Name
- "owner name" → Owner.Name
- "created by" → CreatedBy.Name

STATUS MAPPING:
- "open" cases → Status NOT IN ('Closed')
- "pending" cases → Status IN ('New', 'Working', 'Escalated', 'On Hold')
- "open and pending" → Status NOT IN ('Closed')
- "closed" → Status = 'Closed'
- "open" opportunities → IsClosed = false
- "won" → IsWon = true

EXAMPLES:
Q: "how many cases are pending and open, give me case number and contact name"
A: SELECT Id, CaseNumber, Subject, Status, Priority, Contact.Name FROM Case WHERE Status NOT IN ('Closed') LIMIT 50

Q: "show all accounts in technology industry"
A: SELECT Id, Name, Phone, Industry, AnnualRevenue FROM Account WHERE Industry = 'Technology' LIMIT 50

Q: "how many open opportunities do I have"
A: SELECT COUNT() FROM Opportunity WHERE IsClosed = false`,
    question
  );
}

// ── NEW: Step A — Parse comparison intent ────────────────────────
async function parseComparisonIntent(question) {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const text = await gptCall(
    `You are a Salesforce SOQL date expert. Today's date is ${today}.

The user wants to compare two time periods. Parse their question and return a JSON object with this exact shape:
{
  "periodA": {
    "label": "This Week",
    "dateFilter": "CreatedDate >= THIS_WEEK"
  },
  "periodB": {
    "label": "Last Week",
    "dateFilter": "CreatedDate >= LAST_WEEK AND CreatedDate < THIS_WEEK"
  },
  "objectHint": "Opportunity",
  "metricField": "Amount",
  "metricLabel": "Revenue",
  "aggregation": "SUM",
  "groupByField": null,
  "additionalFields": ["Name", "StageName", "CloseDate"]
}

RULES:
- Return ONLY valid JSON, no markdown, no explanation.
- aggregation can be: SUM, COUNT, AVG, MAX, MIN
- For revenue/amount questions → metricField = "Amount", aggregation = "SUM"
- For count questions → metricField = "Id", aggregation = "COUNT"
- For average deal size → metricField = "Amount", aggregation = "AVG"
- groupByField: if user wants breakdown by stage/owner/type etc, set that field name, else null
- additionalFields: extra fields to SELECT for record-level detail (max 5), or empty array []
- Use Salesforce date literals: THIS_WEEK, LAST_WEEK, THIS_MONTH, LAST_MONTH, THIS_QUARTER, LAST_QUARTER, THIS_YEAR, LAST_YEAR, LAST_N_DAYS:7, LAST_N_DAYS:30, etc.
- For "last 7 days vs previous 7 days" → use LAST_N_DAYS:7 and the prior window
- For year-over-year: THIS_YEAR vs LAST_YEAR

EXAMPLES:
"compare this week revenue vs last week" →
  periodA: THIS_WEEK, periodB: LAST_WEEK, metric: Amount, SUM

"growth % of opportunities this year vs last year" →
  periodA: THIS_YEAR, periodB: LAST_YEAR, metric: Amount, SUM

"how many cases were created this month vs last month" →
  periodA: THIS_MONTH, periodB: LAST_MONTH, metric: Id, COUNT

"average deal size this quarter vs last quarter" →
  periodA: THIS_QUARTER, periodB: LAST_QUARTER, metric: Amount, AVG`,
    question
  );

  try { return JSON.parse(text); } catch (e) {
    throw new Error(`Could not parse comparison intent: ${e.message}. GPT returned: ${text}`);
  }
}

// ── NEW: Fetch real schema for comparison ────────────────────────
async function fetchSchema(conn, objectName) {
  try {
    const meta = await conn.sobject(objectName).describe();
    return {
      label: meta.label,
      fields: meta.fields
        .filter(f => !f.deprecatedAndHidden)
        .map(f => ({
          name: f.name, label: f.label, type: f.type,
          picklistValues: f.type === "picklist" ? f.picklistValues.map(p => p.value) : undefined
        }))
    };
  } catch (e) { return null; }
}

// ── NEW: Build comparison SOQL queries ───────────────────────────
async function buildComparisonSOQL(intent, schema, objectName) {
  const { periodA, periodB, metricField, aggregation, groupByField, additionalFields } = intent;

  // Validate fields exist in schema
  const fieldNames = schema?.fields?.map(f => f.name) || [];

  // Build SELECT clause
  let selectClause;
  if (aggregation === "COUNT") {
    selectClause = groupByField && fieldNames.includes(groupByField)
      ? `${groupByField}, COUNT(Id) cnt`
      : `COUNT(Id) cnt`;
  } else {
    const aggFn = `${aggregation}(${metricField}) metric`;
    selectClause = groupByField && fieldNames.includes(groupByField)
      ? `${groupByField}, ${aggFn}`
      : aggFn;
  }

  const groupBy = groupByField && fieldNames.includes(groupByField) ? ` GROUP BY ${groupByField}` : "";

  const soqlA = `SELECT ${selectClause} FROM ${objectName} WHERE ${periodA.dateFilter}${groupBy}`;
  const soqlB = `SELECT ${selectClause} FROM ${objectName} WHERE ${periodB.dateFilter}${groupBy}`;

  // Also build a record-level query for detail (top 20)
  const detailFields = ["Id", ...((additionalFields || []).filter(f => fieldNames.includes(f)))].join(", ");
  const soqlADetail = `SELECT ${detailFields} FROM ${objectName} WHERE ${periodA.dateFilter} LIMIT 20`;
  const soqlBDetail = `SELECT ${detailFields} FROM ${objectName} WHERE ${periodB.dateFilter} LIMIT 20`;

  return { soqlA, soqlB, soqlADetail, soqlBDetail };
}

// ── NEW: Extract aggregate value from result ─────────────────────
function extractAggregateValue(records, aggregation) {
  if (!records || records.length === 0) return 0;
  if (records.length === 1) {
    const r = records[0];
    const val = r.metric ?? r.cnt ?? r.expr0 ?? 0;
    return parseFloat(val) || 0;
  }
  return records.map(r => ({
    group: Object.entries(r).filter(([k]) => !["attributes", "metric", "cnt", "expr0"].includes(k)).map(([k, v]) => `${k}: ${v}`).join(", "),
    value: parseFloat(r.metric ?? r.cnt ?? r.expr0 ?? 0) || 0
  }));
}

// ── NEW: AI analysis of comparison results (Strict Answer Only) ──
async function analyzeComparison(intent, periodAData, periodBData, detailA, detailB, soqlA, soqlB) {
  const payload = {
    question: intent._originalQuestion,
    periodA: { label: intent.periodA.label, aggregateResult: periodAData },
    periodB: { label: intent.periodB.label, aggregateResult: periodBData },
    metricLabel: intent.metricLabel,
    aggregation: intent.aggregation
  };

  return await gptCall(
    `You are a strict automated data calculation system. You have been given period-over-period data to evaluate.
    
STRICT OUTPUT LIMITATIONS:
- Return ONLY the absolute calculated answers (exact numeric variations, totals, percentages, or breakdown differences).
- DO NOT write summaries, explanations, paragraphs, or introductory text.
- Do not add conversational comments, backticks, or analysis prose.

FORMATTING STRATEGY:
- Use clear headers with emojis for structural separation.
- Format currency fields explicitly using $ signs and thousands separators (e.g., $1,234,567).
- Compute growth % as ((Period A - Period B) / Period B) * 100, bounded to 2 decimal places. Prepend with clear + or - signs (e.g., +12.50%).
- Apply the indicator 📈 if delta is positive, 📉 if delta is negative, and ➡️ if completely flat.`,
    JSON.stringify(payload)
  );
}

// ── Format results with links ────────────────────────────────────
function formatResults(records, soql) {
  if (!records || records.length === 0) return null;
  const fromMatch = soql.match(/FROM\s+(\w+)/i);
  const objectName = fromMatch ? fromMatch[1] : null;

  const formatted = records.map((r, i) => {
    const lines = [`--- Record ${i + 1} ---`];
    for (const [key, val] of Object.entries(r)) {
      if (key === "attributes") continue;
      if (key === "Id" && objectName) {
        lines.push(`Id: ${val}`);
        lines.push(`Link: ${SF_BASE_URL}/lightning/r/${objectName}/${val}/view`);
      } else if (val && typeof val === "object" && val.attributes) {
        for (const [rKey, rVal] of Object.entries(val)) {
          if (rKey !== "attributes") lines.push(`${key}.${rKey}: ${rVal}`);
        }
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    return lines.join("\n");
  });

  return formatted.join("\n\n");
}

// ── TOOL 1: Get Object Schema ────────────────────────────────────
server.tool("get_object_schema",
  `Get Salesforce schema. Call with NO params to get all objects index.
   Pass specific object names to get field details.
   Always call this before soql_query.`,
  { objects: z.string().optional().describe("Comma-separated object API names e.g. 'Account,Opportunity'. Omit to get full index.") },
  async ({ objects }) => {
    const conn = await getSFConn();
    if (!objects) {
      const globalDesc = await conn.describeGlobal();
      const index = globalDesc.sobjects
        .filter(o => o.queryable)
        .map(o => ({ name: o.name, label: o.label, custom: o.custom }));
      return { content: [{ type: "text", text: `Total queryable objects: ${index.length}\n\n${JSON.stringify(index, null, 2)}` }] };
    }
    const objectList = objects.split(",").map(o => o.trim());
    const schemas = {};
    for (const objName of objectList) {
      try {
        const meta = await conn.sobject(objName).describe();
        schemas[objName] = {
          label: meta.label,
          fields: meta.fields.map(f => ({
            name: f.name, label: f.label, type: f.type,
            required: !f.nillable && !f.defaultedOnCreate,
            picklistValues: f.type === "picklist" ? f.picklistValues.map(p => p.value) : undefined
          }))
        };
      } catch (e) {
        schemas[objName] = { error: `Object not found: ${e.message}` };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(schemas, null, 2) }] };
  }
);

// ── TOOL 2: Ask Salesforce in Plain English ──────────────────────
server.tool("ask_salesforce",
  `Ask any question in plain English about ANY Salesforce data.
   Automatically detects objects, fetches real schema, generates SOQL, runs query.`,
  { question: z.string().describe("Plain English question about your Salesforce data") },
  async ({ question }) => {
    try {
      const conn = await getSFConn();
      const globalDesc = await conn.describeGlobal();
      const allObjects = globalDesc.sobjects.filter(o => o.queryable).map(o => ({ name: o.name, label: o.label }));
      const detectedObjects = await detectObjects(question, allObjects);
      const schemas = {};
      for (const objName of detectedObjects) {
        try {
          const meta = await conn.sobject(objName).describe();
          schemas[objName] = {
            label: meta.label,
            fields: meta.fields.filter(f => !f.deprecatedAndHidden).map(f => ({
              name: f.name, label: f.label, type: f.type,
              picklistValues: f.type === "picklist" ? f.picklistValues.map(p => p.value) : undefined
            }))
          };
        } catch (e) { /* skip inaccessible */ }
      }
      const soql = await generateSOQL(question, schemas);
      const result = await conn.query(soql);
      if (result.records.length === 0) {
        return { content: [{ type: "text", text: `✅ Count: ${result.totalSize}\nGenerated SOQL: ${soql}` }] };
      }
      const formatted = formatResults(result.records, soql);
      return { content: [{ type: "text", text: `✅ Found ${result.totalSize} records\nGenerated SOQL: ${soql}\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ── TOOL 3: Raw SOQL Query ───────────────────────────────────────
server.tool("soql_query",
  "Run a raw SOQL query. Use ask_salesforce for plain English questions.",
  { q: z.string().describe("Valid SOQL query") },
  async ({ q }) => {
    const conn = await getSFConn();
    try {
      const result = await conn.query(q);
      if (result.records.length === 0) {
        return { content: [{ type: "text", text: `Count: ${result.totalSize}\nQuery: ${q}` }] };
      }
      const formatted = formatResults(result.records, q);
      return { content: [{ type: "text", text: `Total: ${result.totalSize}\nQuery: ${q}\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ SOQL Error: ${e.message}` }] };
    }
  }
);

// ── TOOL 4: Create Record ────────────────────────────────────────
server.tool("create_record",
  "Create a record in any Salesforce object. Use get_object_schema first to know required fields.",
  {
    objectName: z.string().describe("Salesforce object API name"),
    fields: z.record(z.any()).describe("Field API names and values as JSON")
  },
  async ({ objectName, fields }) => {
    const conn = await getSFConn();
    try {
      const result = await conn.sobject(objectName).create(fields);
      return { content: [{ type: "text", text: `✅ Created ${objectName}. ID: ${result.id}\nLink: ${SF_BASE_URL}/lightning/r/${objectName}/${result.id}/view` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Create failed: ${e.message}` }] };
    }
  }
);

// ── TOOL 5: Update Record ────────────────────────────────────────
server.tool("update_record",
  "Update any Salesforce record by ID.",
  {
    objectName: z.string().describe("Salesforce object API name"),
    id: z.string().describe("Salesforce Record ID"),
    fields: z.record(z.any()).describe("Fields to update as JSON")
  },
  async ({ objectName, id, fields }) => {
    const conn = await getSFConn();
    try {
      await conn.sobject(objectName).update({ Id: id, ...fields });
      return { content: [{ type: "text", text: `✅ Updated ${objectName} record.\nLink: ${SF_BASE_URL}/lightning/r/${objectName}/${id}/view` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Update failed: ${e.message}` }] };
    }
  }
);

// ── TOOL 6: Delete Record ────────────────────────────────────────
server.tool("delete_record",
  "Delete any Salesforce record by ID.",
  {
    objectName: z.string().describe("Salesforce object API name"),
    id: z.string().describe("Salesforce Record ID to delete")
  },
  async ({ objectName, id }) => {
    const conn = await getSFConn();
    try {
      await conn.sobject(objectName).delete(id);
      return { content: [{ type: "text", text: `✅ Deleted ${objectName} record ${id}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Delete failed: ${e.message}` }] };
    }
  }
);

// ── TOOL 7: Upsert Record ────────────────────────────────────────
server.tool("upsert_record",
  "Upsert a Salesforce record using an external ID field.",
  {
    objectName: z.string().describe("Salesforce object API name"),
    externalIdField: z.string().describe("External ID field API name e.g. Email"),
    fields: z.record(z.any()).describe("All field values including the external ID")
  },
  async ({ objectName, externalIdField, fields }) => {
    const conn = await getSFConn();
    try {
      const result = await conn.sobject(objectName).upsert(fields, externalIdField);
      return { content: [{ type: "text", text: `✅ Upsert successful. Created: ${result.created}, ID: ${result.id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Upsert failed: ${e.message}` }] };
    }
  }
);

// ════════════════════════════════════════════════════════════════
// ── TOOL 8: Compare Salesforce Data Across Two Time Periods ─────
// ════════════════════════════════════════════════════════════════
server.tool("compare_salesforce",
  `Compare Salesforce data across two time periods with AI-powered analysis.`,
  {
    question: z.string().describe("Plain English comparison question mentioning two time periods")
  },
  async ({ question }) => {
    try {
      const conn = await getSFConn();

      // ── Step 1: Parse what the user wants to compare ──────────
      const intent = await parseComparisonIntent(question);
      intent._originalQuestion = question;

      // ── Step 2: Detect Salesforce object ─────────────────────
      const globalDesc = await conn.describeGlobal();
      const allObjects = globalDesc.sobjects.filter(o => o.queryable).map(o => ({ name: o.name, label: o.label }));
      const detectedObjects = await detectObjects(question, allObjects);
      const objectName = intent.objectHint || detectedObjects[0] || "Opportunity";

      // ── Step 3: Fetch real schema for field validation ────────
      const schema = await fetchSchema(conn, objectName);

      // ── Step 4: Build SOQL for both periods ───────────────────
      const { soqlA, soqlB, soqlADetail, soqlBDetail } = await buildComparisonSOQL(intent, schema, objectName);

      // ── Step 5: Run all 4 queries in parallel ─────────────────
      let [resultA, resultB, detailResultA, detailResultB] = await Promise.all([
        conn.query(soqlA).catch(e => ({ records: [], totalSize: 0, _err: e.message })),
        conn.query(soqlB).catch(e => ({ records: [], totalSize: 0, _err: e.message })),
        conn.query(soqlADetail).catch(() => ({ records: [] })),
        conn.query(soqlBDetail).catch(() => ({ records: [] }))
      ]);

      // Handle COUNT() queries (totalSize = the count, records = [])
      const aggA = resultA.records.length === 0 && resultA.totalSize > 0
        ? resultA.totalSize
        : extractAggregateValue(resultA.records, intent.aggregation);

      const aggB = resultB.records.length === 0 && resultB.totalSize > 0
        ? resultB.totalSize
        : extractAggregateValue(resultB.records, intent.aggregation);

      // ── Step 6: AI calculates the raw answers without commentary ──
      const analysis = await analyzeComparison(
        intent,
        aggA,
        aggB,
        detailResultA.records,
        detailResultB.records,
        soqlA,
        soqlB
      );

      // ── Step 7: Build final direct response ───────────────────
      return {
        content: [{
          type: "text",
          text: analysis.trim()
        }]
      };

    } catch (e) {
      return {
        content: [{
          type: "text",
          text: `❌ Comparison Error: ${e.message}`
        }]
      };
    }
  }
);

// ── HTTP Server for Salesforce LWC / Public Access ───────────────
import express from "express";
const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", server: "Salesforce MCP Server" });
});

// Main endpoint — LWC / any client calls this
app.post("/ask", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "question is required" });

  // ── Auto-detect comparison questions and route accordingly ──
  const isComparison = /compare|vs|versus|increase|decrease|grew|growth|more than last|less than last|this month.*last month|last month.*this month|this week.*last week|this year.*last year|this quarter.*last quarter/i.test(question);

  if (isComparison) {
    // Route to compare logic
    try {
      const conn = await getSFConn();
      const intent = await parseComparisonIntent(question);
      intent._originalQuestion = question;
      const allObjects = (await conn.describeGlobal()).sobjects.filter(o => o.queryable).map(o => ({ name: o.name, label: o.label }));
      const detectedObjects = await detectObjects(question, allObjects);
      const objectName = intent.objectHint || detectedObjects[0] || "Opportunity";
      const schema = await fetchSchema(conn, objectName);
      const { soqlA, soqlB } = await buildComparisonSOQL(intent, schema, objectName);
      const [resultA, resultB] = await Promise.all([
        conn.query(soqlA).catch(() => ({ records: [], totalSize: 0 })),
        conn.query(soqlB).catch(() => ({ records: [], totalSize: 0 }))
      ]);
      const aggA = resultA.records.length === 0 ? resultA.totalSize : extractAggregateValue(resultA.records, intent.aggregation);
      const aggB = resultB.records.length === 0 ? resultB.totalSize : extractAggregateValue(resultB.records, intent.aggregation);
      const analysis = await analyzeComparison(intent, aggA, aggB, soqlA, soqlB);
      return res.json({ 
        success: true, 
        type: "comparison",
        analysis, 
        periodA: { label: intent.periodA.label, value: aggA }, 
        periodB: { label: intent.periodB.label, value: aggB }, 
        soqlA, 
        soqlB 
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── Normal question → generate SOQL and query ──
  try {
    const conn = await getSFConn();
    const allObjects = (await conn.describeGlobal()).sobjects.filter(o => o.queryable).map(o => ({ name: o.name, label: o.label }));
    const detectedObjects = await detectObjects(question, allObjects);
    const schemas = {};
    for (const objName of detectedObjects) {
      try {
        const meta = await conn.sobject(objName).describe();
        schemas[objName] = {
          label: meta.label,
          fields: meta.fields.filter(f => !f.deprecatedAndHidden).map(f => ({
            name: f.name, label: f.label, type: f.type,
            picklistValues: f.type === "picklist" ? f.picklistValues.map(p => p.value) : undefined
          }))
        };
      } catch { }
    }
    const soql = await generateSOQL(question, schemas);
    const result = await conn.query(soql);
    return res.json({ 
      success: true, 
      type: "query",
      count: result.totalSize, 
      records: result.records, 
      soql 
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Compare endpoint
app.post("/compare", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "question is required" });
  try {
    const conn = await getSFConn();
    const intent = await parseComparisonIntent(question);
    intent._originalQuestion = question;
    const allObjects = (await conn.describeGlobal()).sobjects.filter(o => o.queryable).map(o => ({ name: o.name, label: o.label }));
    const detectedObjects = await detectObjects(question, allObjects);
    const objectName = intent.objectHint || detectedObjects[0] || "Opportunity";
    const schema = await fetchSchema(conn, objectName);
    const { soqlA, soqlB } = await buildComparisonSOQL(intent, schema, objectName);
    const [resultA, resultB] = await Promise.all([
      conn.query(soqlA).catch(() => ({ records: [], totalSize: 0 })),
      conn.query(soqlB).catch(() => ({ records: [], totalSize: 0 }))
    ]);
    const aggA = resultA.records.length === 0 ? resultA.totalSize : extractAggregateValue(resultA.records, intent.aggregation);
    const aggB = resultB.records.length === 0 ? resultB.totalSize : extractAggregateValue(resultB.records, intent.aggregation);
    const analysis = await analyzeComparison(intent, aggA, aggB, soqlA, soqlB);
    res.json({ success: true, analysis, periodA: { label: intent.periodA.label, value: aggA }, periodB: { label: intent.periodB.label, value: aggB }, soqlA, soqlB });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start both MCP (STDIO) and HTTP together
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.error(`HTTP Server running on port ${PORT}`));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Salesforce MCP Server running");
