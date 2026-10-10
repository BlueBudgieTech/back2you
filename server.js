import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { registerStore } from "./store.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMMA_MODEL || "gemma-4-31b-it";
const DATA_DIR = path.join(process.cwd(), "data");
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const DB_FILE = path.join(DATA_DIR, "items.json");
const VERIFICATIONS_FILE = path.join(DATA_DIR, "verifications.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const activeSessions = new Map();

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });
try { await fs.access(DB_FILE); }
catch { await fs.writeFile(DB_FILE, "[]\n", "utf8"); }
try { await fs.access(VERIFICATIONS_FILE); }
catch { await fs.writeFile(VERIFICATIONS_FILE, "[]\n", "utf8"); }
try { await fs.access(USERS_FILE); }
catch {
    // Demo-only accounts. Do not use plain-text passwords for a real deployment.
    await fs.writeFile(USERS_FILE, JSON.stringify([
        { username: "report", password: "123" },
        { username: "find", password: "123" }
    ], null, 2) + "\n", "utf8");
}

async function readItems() {
    try { return JSON.parse(await fs.readFile(DB_FILE, "utf8")); }
    catch (error) {
        console.error("Could not read local mock database:", error);
        throw new Error("The local mock database could not be read.");
    }
}
async function writeItems(items) {
    await fs.writeFile(DB_FILE, JSON.stringify(items, null, 2) + "\n", "utf8");
}
const diskImageUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => {
            const ext = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" })[file.mimetype];
            cb(null, `${Date.now()}-${randomUUID()}${ext || ".img"}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            return cb(new Error("Please upload a JPG, PNG, or WEBP image."));
        }
        cb(null, true);
    }
});
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.json({ limit: "4mb" }));

if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set. Add it to your .env file before using image analysis.");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        if (!allowed.includes(file.mimetype)) {
            return callback(new Error("Please upload a JPG, PNG, or WEBP image."));
        }
        callback(null, true);
    }
});

// Serve only the public folder (never the project root, which holds .env and data/).
app.use(express.static(path.join(process.cwd(), "public")));

// Login and signup are unauthenticated; sessions are in-memory demo tokens.
app.post("/api/signup", async (req, res) => {
    try {
        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
            return res.status(400).json({ error: "Username must be 3–20 characters using letters, numbers, or underscores." });
        }
        if (password.length < 4 || password.length > 128) {
            return res.status(400).json({ error: "Password must be at least 4 characters long." });
        }
        const users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
        if (users.some(entry => entry.username.toLowerCase() === username.toLowerCase())) {
            return res.status(409).json({ error: "That username is already taken. Please choose another." });
        }
        users.push({ username, password });
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2) + "\n", "utf8");
        const token = randomUUID();
        activeSessions.set(token, { username, createdAt: Date.now() });
        res.status(201).json({ token, username });
    } catch (error) {
        console.error("Signup failed:", error);
        res.status(500).json({ error: "Could not create account. Please try again." });
    }
});
app.post("/api/login", async (req, res) => {
    try {
        const username = safeText(req.body?.username);
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
        const user = users.find(entry => entry.username === username && entry.password === password);
        if (!user) return res.status(401).json({ error: "Incorrect username or password." });
        const token = randomUUID();
        activeSessions.set(token, { username: user.username, createdAt: Date.now() });
        res.json({ token, username: user.username });
    } catch (error) {
        console.error("Login failed:", error);
        res.status(500).json({ error: "Could not log in. Please try again." });
    }
});
app.post("/api/logout", requireLogin, (req, res) => {
    activeSessions.delete(req.authToken);
    res.json({ message: "Logged out." });
});
function requireLogin(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = activeSessions.get(token);
    if (!session) return res.status(401).json({ error: "Please log in to continue." });
    req.authToken = token;
    req.authUser = session;
    next();
}
app.use("/api", (req, res, next) => {
    if (req.path === "/login" || req.path === "/signup") return next();
    return requireLogin(req, res, next);
});

// Local JSON mock database API. Reports are saved in data/items.json.
app.get("/api/items", async (_req, res) => {
    try { res.json(await readItems()); }
    catch { res.status(500).json({ error: "Could not load saved reports." }); }
});

app.get("/api/items/found", async (_req, res) => {
    try {
        const items = await readItems();
        res.json(items.filter(item => item.type === "found" && item.status === "open"));
    } catch { res.status(500).json({ error: "Could not load found-item reports." }); }
});

app.post("/api/items/found", diskImageUpload.single("image"), async (req, res) => {
    try {
        const category = safeText(req.body.category);
        const primaryColor = safeText(req.body.primaryColor);
        const location = safeText(req.body.location);
        const date = safeText(req.body.date);
        if ([category, primaryColor, location, date].some(v => v === "Unknown")) {
            if (req.file) await fs.unlink(req.file.path).catch(() => {});
            return res.status(400).json({ error: "Please complete category, primary colour, location, and date." });
        }
        const items = await readItems();
        const report = {
            id: randomUUID(), type: "found", owner: req.authUser.username, category, primary_color: primaryColor,
            location, date, photo: req.file ? `/uploads/${req.file.filename}` : null,
            status: "open", created_at: new Date().toISOString()
        };
        items.push(report);
        // Keep found-item submission fast: update existing lost reports using local
        // similarity scoring instead of waiting for a separate Gemma request for
        // every lost report. AI ranking is still available when a user submits a
        // lost report, but it is not on this submission's critical path.
        const earlierLost = items.filter(item =>
            item.type === "lost" && item.status === "open" && item.owner !== report.owner
        );
        for (const lost of earlierLost) {
            const candidates = items.filter(item =>
                item.type === "found" && item.status === "open" && item.owner !== lost.owner
            );
            lost.matches = candidates
                .map(candidate => scoreMatch(lost, candidate))
                .sort((a, b) => b.match_score - a.match_score)
                .slice(0, 5);
        }
        await writeItems(items);
        res.status(201).json({ message: "Found-item report saved.", item: report, matching_method: "local-similarity" });
    } catch (error) {
        console.error("Saving found item failed:", error);
        res.status(500).json({ error: "Could not save this found-item report." });
    }
});

function normalized(value) {
    return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}
function similarity(a, b) {
    const x = normalized(a), y = normalized(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.8;
    const xs = new Set(x.split(/\s+/)), ys = new Set(y.split(/\s+/));
    const intersection = [...xs].filter(token => ys.has(token)).length;
    return intersection / new Set([...xs, ...ys]).size;
}
function scoreMatch(lost, found) {
    const category = similarity(lost.category, found.category);
    const color = similarity(lost.primary_color, found.primary_color);
    const location = similarity(lost.location_last_seen, found.location);
    const lostDate = Date.parse(lost.date), foundDate = Date.parse(found.date);
    const daysApart = Number.isFinite(lostDate) && Number.isFinite(foundDate)
        ? Math.abs(lostDate - foundDate) / 86400000 : 9999;
    const dateScore = daysApart <= 1 ? 1 : daysApart <= 3 ? 0.8 : daysApart <= 7 ? 0.55 : daysApart <= 30 ? 0.25 : 0;
    const score = Math.round((category * 0.45 + color * 0.25 + location * 0.20 + dateScore * 0.10) * 100);
    const reasons = [];
    if (category >= 0.5) reasons.push("similar category");
    if (color >= 0.5) reasons.push("similar colour");
    if (location >= 0.5) reasons.push("similar location");
    if (daysApart <= 7) reasons.push("reported within 7 days");
    return { ...found, match_score: score, match_reasons: reasons.length ? reasons : ["closest available report"] };
}

function rankMatchesLocally(lost, foundItems) {
    // Deterministic, local matching: no network or AI calls are made.
    return foundItems
        .map(item => scoreMatch(lost, item))
        .sort((a, b) => b.match_score - a.match_score)
        .slice(0, 5);
}

app.post("/api/items/lost", diskImageUpload.single("photo"), async (req, res) => {
    try {
        const category = safeText(req.body.category);
        const primaryColor = safeText(req.body.primaryColor);
        const location = safeText(req.body.location);
        const date = safeText(req.body.date);
        if ([category, primaryColor, location, date].some(v => v === "Unknown")) {
            if (req.file) await fs.unlink(req.file.path).catch(() => {});
            return res.status(400).json({ error: "Please complete category, primary colour, location, and date." });
        }
        const items = await readItems();
        const report = {
            id: randomUUID(), type: "lost", owner: req.authUser.username, category, primary_color: primaryColor,
            location_last_seen: location, date, photo: req.file ? `/uploads/${req.file.filename}` : null,
            status: "open", created_at: new Date().toISOString(), matches: []
        };
        const candidates = items.filter(item => item.type === "found" && item.status === "open" && item.owner !== req.authUser.username);
        report.matches = rankMatchesLocally(report, candidates);
        items.push(report);
        await writeItems(items);
        res.status(201).json({ message: "Lost-item report saved.", item: report, matches: report.matches, matching_method: "local-similarity" });
    } catch (error) {
        console.error("Saving lost item failed:", error);
        res.status(500).json({ error: "Could not save this lost-item report." });
    }
});

app.get("/api/dashboard", async (req, res) => {
    try {
        const username = req.authUser.username;
        const items = await readItems();
        let verifications = [];
        try { verifications = JSON.parse(await fs.readFile(VERIFICATIONS_FILE, "utf8")); } catch { verifications = []; }
        const ownFound = items.filter(item => item.type === "found" && item.owner === username);
        const ownLost = items.filter(item => item.type === "lost" && item.owner === username);
        const ownLostWithMatches = ownLost.map(lost => ({
            ...lost,
            // Show the Retrieved action only after this user's verification is approved.
            retrieved_available: verifications.some(claim =>
                claim.status === "approved" &&
                claim.lost_report_id === lost.id &&
                claim.claimant === username
            ),
            // Keep the last locally ranked result stable; do not run matching on every dashboard poll.
            matches: Array.isArray(lost.matches) ? lost.matches.slice(0, 3) : []
        }));
        // Route each claim to the account that owns the found-item report.
        // The saved owner is the primary route; item ownership is a fallback for older mock data.
        const incomingClaims = verifications.filter(claim => {
            const item = items.find(entry => entry.id === claim.found_item_id && entry.type === "found");
            return claim.owner === username || (item && item.owner === username);
        }).map(claim => ({
            ...claim,
            owner: claim.owner || (items.find(entry => entry.id === claim.found_item_id) || {}).owner,
            found_item: items.find(entry => entry.id === claim.found_item_id && entry.type === "found") || null,
            lost_item: items.find(entry => entry.id === claim.lost_report_id && entry.type === "lost") || null
        }));
        const myClaims = verifications.filter(claim => claim.claimant === username).map(claim => ({
            ...claim,
            found_item: items.find(entry => entry.id === claim.found_item_id) || null
        }));
        res.json({ username, found_items: ownFound, lost_items: ownLostWithMatches, incoming_claims: incomingClaims, my_claims: myClaims });
    } catch (error) {
        console.error("Loading dashboard failed:", error);
        res.status(500).json({ error: "Could not load dashboard." });
    }
});

// The owner of a lost report can remove it only after their associated claim is approved.
app.post("/api/items/:id/retrieved", async (req, res) => {
    try {
        const items = await readItems();
        // Resolve by the exact report ID and type. Refuse to delete anything if
        // the ID is missing or duplicated: a Retrieved action must never bulk-delete
        // a user's other lost reports.
        const requestedId = req.params.id;
        if (!requestedId || typeof requestedId !== "string") {
            return res.status(400).json({ error: "A valid lost-item report ID is required." });
        }
        const matchingLostIndexes = [];
        items.forEach((item, index) => {
            if (item.type === "lost" && item.id === requestedId) matchingLostIndexes.push(index);
        });
        if (matchingLostIndexes.length === 0) {
            return res.status(404).json({ error: "This lost-item report was not found." });
        }
        if (matchingLostIndexes.length !== 1) {
            console.error(`Refusing Retrieved action: duplicate lost report ID ${requestedId}`);
            return res.status(409).json({ error: "This report ID is duplicated in the local database. No reports were deleted; please fix the duplicate IDs first." });
        }
        const lostIndex = matchingLostIndexes[0];
        const lostItem = items[lostIndex];
        if (lostItem.owner !== req.authUser.username) {
            return res.status(403).json({ error: "Only the person who reported this lost item can mark it retrieved." });
        }
        let verifications = [];
        try { verifications = JSON.parse(await fs.readFile(VERIFICATIONS_FILE, "utf8")); } catch { verifications = []; }
        const approvedClaim = verifications.find(claim =>
            claim.status === "approved" &&
            claim.lost_report_id === lostItem.id &&
            claim.claimant === req.authUser.username
        );
        if (!approvedClaim) {
            return res.status(409).json({ error: "This item can only be marked retrieved after its verification is approved." });
        }

        // Close the associated found report too, so it no longer appears as open
        // to the person who found it or in future matching results.
        const foundItem = items.find(item =>
            item.id === approvedClaim.found_item_id && item.type === "found"
        );
        if (foundItem) {
            foundItem.status = "retrieved";
            foundItem.retrieved_at = new Date().toISOString();
        }

        // Remove the lost report and any cached matches that point to the now-closed
        // found report. Keep the verification record as an audit trail.
        // Delete by array index, not a broad predicate over IDs, so exactly one
        // lost report is removed and every unrelated lost/found report is retained.
        // Filter by the exact ID only after verifying it occurs exactly once.
        // Also assert the removed ID count, so an unexpected data shape fails closed.
        const remainingItems = items.filter(item => !(item.type === "lost" && item.id === requestedId));
        const removedCount = items.length - remainingItems.length;
        if (removedCount !== 1 || remainingItems.some(item => item.id === requestedId && item.type === "lost")) {
            throw new Error(`Safety check failed: expected to remove exactly one lost report, removed ${removedCount}.`);
        }
        if (foundItem) {
            for (const item of remainingItems) {
                if (Array.isArray(item.matches)) {
                    item.matches = item.matches.filter(match => match.id !== foundItem.id);
                }
            }
        }
        await writeItems(remainingItems);
        res.json({ message: "Item marked retrieved. The lost report was removed and the associated found report was closed.", found_item_id: foundItem?.id || null });
    } catch (error) {
        console.error("Marking item retrieved failed:", error);
        res.status(500).json({ error: "Could not mark this item retrieved." });
    }
});

app.post("/api/verifications", async (req, res) => {
    try {
        const foundItemId = safeText(req.body.found_item_id);
        const lostReportId = req.body.lost_report_id ? safeText(req.body.lost_report_id) : null;
        const extraDetails = safeText(req.body.extra_details);
        const uniqueIdentifications = safeText(req.body.unique_identifications);
        if ([foundItemId, extraDetails, uniqueIdentifications].some(value => value === "Unknown")) {
            return res.status(400).json({ error: "Please complete both verification questions." });
        }
        const items = await readItems();
        const foundItem = items.find(item => item.id === foundItemId && item.type === "found");
        if (!foundItem) return res.status(404).json({ error: "This found-item report could not be found." });
        if (foundItem.owner === req.authUser.username) return res.status(400).json({ error: "You cannot submit a claim for your own found-item report." });
        let verifications = [];
        try { verifications = JSON.parse(await fs.readFile(VERIFICATIONS_FILE, "utf8")); } catch { verifications = []; }
        const verification = {
            id: randomUUID(), found_item_id: foundItemId, lost_report_id: lostReportId,
            claimant: req.authUser.username, owner: foundItem.owner,
            extra_details: extraDetails, unique_identifications: uniqueIdentifications,
            status: "pending", decision_message: "Claim waiting for approval", contact_details: null,
            created_at: new Date().toISOString()
        };
        verifications.push(verification);
        await fs.writeFile(VERIFICATIONS_FILE, JSON.stringify(verifications, null, 2) + "\n", "utf8");
        res.status(201).json({ message: "Verification sent.", verification });
    } catch (error) {
        console.error("Saving verification failed:", error);
        res.status(500).json({ error: "Could not save this verification." });
    }
});

app.post("/api/verifications/:id/decision", async (req, res) => {
    try {
        const decision = req.body?.decision;
        const contactDetails = typeof req.body?.contact_details === "string" ? req.body.contact_details.trim().slice(0, 500) : "";
        if (!["approved", "declined"].includes(decision)) return res.status(400).json({ error: "Choose approve or decline." });
        if (decision === "approved" && !contactDetails) return res.status(400).json({ error: "Please provide contact details to share with the claimant." });
        const items = await readItems();
        const foundItems = items;
        let verifications = [];
        try { verifications = JSON.parse(await fs.readFile(VERIFICATIONS_FILE, "utf8")); } catch { verifications = []; }
        const claim = verifications.find(entry => entry.id === req.params.id);
        if (!claim) return res.status(404).json({ error: "Claim not found." });
        const foundItem = foundItems.find(entry => entry.id === claim.found_item_id);
        if (!foundItem || foundItem.owner !== req.authUser.username) return res.status(403).json({ error: "Only the person who reported this found item can decide this claim." });
        if (claim.status !== "pending") return res.status(409).json({ error: "This claim has already been decided." });
        claim.status = decision;
        claim.decision_message = decision === "approved" ? "Claim approved" : "claim denied: insufficient evidence";
        claim.contact_details = decision === "approved" ? contactDetails : null;
        claim.decided_at = new Date().toISOString();
        await fs.writeFile(VERIFICATIONS_FILE, JSON.stringify(verifications, null, 2) + "\n", "utf8");
        res.json({ message: claim.decision_message, claim });
    } catch (error) {
        console.error("Claim decision failed:", error);
        res.status(500).json({ error: "Could not update this claim." });
    }
});

app.post("/api/analyze-item", upload.single("image"), async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({
                error: "The server API key is not configured. Add GEMINI_API_KEY to your .env file."
            });
        }
        if (!req.file) {
            return res.status(400).json({ error: "Please upload an image first." });
        }

        const prompt = `You are helping describe an item for a college lost-and-found website.
Inspect the image and return ONLY a valid JSON object with exactly these two string keys:
{
  "category": "short generic item category",
  "primary_color": "main visible colour"
}
Rules:
- Describe only the visible object; do not guess the owner, exact model, or hidden details.
- Use a short category such as "water bottle", "backpack", "keychain", or "wallet".
- If the object or colour cannot be identified confidently, use "Unknown".
- No Markdown fences and no extra text.`;

        const response = await ai.interactions.create({
            model: MODEL,
            input: [
                { type: "text", text: prompt },
                {
                    type: "image",
                    mime_type: req.file.mimetype,
                    data: req.file.buffer.toString("base64")
                }
            ]
        });

        const outputText = response.output_text || "";
        const cleaned = outputText.replace(/```(?:json)?/gi, "").trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error("Unexpected model response:", outputText);
            return res.status(502).json({ error: "Gemma 4 did not return readable item details. Please try another image." });
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch {
            return res.status(502).json({ error: "Could not read the AI response. Please try again or enter the details manually." });
        }

        res.json({
            category: safeText(parsed.category),
            primary_color: safeText(parsed.primary_color)
        });
    } catch (error) {
        console.error("Image analysis error:", error);
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ error: "Image must be 5 MB or smaller." });
        }
        res.status(500).json({ error: "Gemma 4 image analysis failed. Check the server log and API configuration." });
    }
});

function safeText(value) {
    if (typeof value !== "string") return "Unknown";
    const cleaned = value.trim().slice(0, 100);
    return cleaned || "Unknown";
}

registerStore(app, { ai, model: MODEL });

app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: "Upload failed. Choose one image up to 5 MB." });
    }
    if (error) return res.status(400).json({ error: error.message || "Invalid request." });
});

app.listen(PORT, () => {
    console.log(`Back2you is running at http://localhost:${PORT}`);
});
