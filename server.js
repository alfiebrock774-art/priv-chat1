const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add your PostgreSQL connection string in Render Environment Variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const clients = new Map();
const games = new Map();

async function db(sql, params = []) {
  return pool.query(sql, params);
}

async function setup() {
  await db(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT,
      group_id UUID,
      body TEXT NOT NULL,
      edited BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS groups (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id UUID NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (group_id, username)
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id UUID NOT NULL,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, username)
    );
  `);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = stored.split(":");
    const actual = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(
      Buffer.from(actual, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastUserList() {
  const users = [...clients.keys()];
  for (const ws of clients.values()) send(ws, { type: "userList", users });
}

async function getUserChats(username) {
  const privateRows = await db(
    `SELECT id,sender,recipient,body,edited,created_at
     FROM messages
     WHERE (sender=$1 OR recipient=$1) AND group_id IS NULL
     ORDER BY created_at ASC`,
    [username]
  );

  const groupRows = await db(
    `SELECT m.id,m.sender,m.recipient,m.group_id,m.body,m.edited,m.created_at,g.name AS group_name
     FROM messages m
     JOIN group_members gm ON gm.group_id=m.group_id AND gm.username=$1
     JOIN groups g ON g.id=m.group_id
     WHERE m.group_id IS NOT NULL
     ORDER BY m.created_at ASC`,
    [username]
  );

  const reactions = await db(
    `SELECT message_id, username, emoji FROM reactions
     WHERE message_id IN (
       SELECT id FROM messages WHERE sender=$1 OR recipient=$1 OR group_id IN
       (SELECT group_id FROM group_members WHERE username=$1)
     )`,
    [username]
  );

  const reactionMap = {};
  for (const r of reactions.rows) {
    if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
    reactionMap[r.message_id].push(r);
  }

  const convert = row => ({
    id: row.id,
    from: row.sender,
    to: row.recipient,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    message: row.body,
    edited: row.edited,
    time: row.created_at,
    reactions: reactionMap[row.id] || []
  });

  return [...privateRows.rows, ...groupRows.rows].map(convert);
}

async function sendHistory(username) {
  const ws = clients.get(username);
  if (!ws) return;

  const messages = await getUserChats(username);

  const groups = await db(
    `SELECT g.id,g.name,g.owner
     FROM groups g
     JOIN group_members gm ON gm.group_id=g.id
     WHERE gm.username=$1
     ORDER BY g.created_at`,
    [username]
  );

  send(ws, {
    type: "history",
    messages,
    groups: groups.rows
  });
}

async function isGroupMember(groupId, username) {
  const r = await db(
    `SELECT 1 FROM group_members WHERE group_id=$1 AND username=$2`,
    [groupId, username]
  );
  return r.rowCount > 0;
}

async function groupMembers(groupId) {
  const r = await db(
    `SELECT username FROM group_members WHERE group_id=$1`,
    [groupId]
  );
  return r.rows.map(x => x.username);
}

async function notifyGroup(groupId, payload) {
  for (const username of await groupMembers(groupId)) {
    send(clients.get(username), payload);
  }
}

function notifyPrivate(a, b, payload) {
  send(clients.get(a), payload);
  send(clients.get(b), payload);
}


function gamePayload(game) {
  return {
    type: game.active ? "gameStarted" : (game.ended ? "gameEnded" : "gameState"),
    groupId: game.groupId,
    host: game.host,
    active: game.active,
    ended: !!game.ended,
    timeLeft: game.active ? Math.max(0, Math.ceil((game.endsAt - Date.now()) / 1000)) : 0,
    targetId: game.targetId || null,
    target: game.target || null,
    players: [...game.players.values()].map(p => ({ username: p.username, score: p.score }))
  };
}

async function broadcastGame(game) {
  await notifyGroup(game.groupId, gamePayload(game));
}

function newTarget() {
  return {
    x: Math.floor(5 + Math.random() * 88),
    y: Math.floor(5 + Math.random() * 78)
  };
}

async function endGame(groupId) {
  const game = games.get(groupId);
  if (!game) return;
  game.active = false;
  game.ended = true;
  game.targetId = null;
  game.target = null;
  await broadcastGame(game);
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end("Priv Chat server");
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", ws => {
  let username = null;

  ws.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "register") {
        const name = String(data.username || "").trim();
        const password = String(data.password || "");

        if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
          return send(ws, { type: "error", message: "Username must be 3-20 letters, numbers or underscores." });
        }
        if (password.length < 6) {
          return send(ws, { type: "error", message: "Password must be at least 6 characters." });
        }

        const exists = await db(`SELECT 1 FROM users WHERE username=$1`, [name]);
        if (exists.rowCount) {
          return send(ws, { type: "error", message: "Username already exists." });
        }

        await db(`INSERT INTO users(username,password_hash) VALUES($1,$2)`, [
          name, hashPassword(password)
        ]);

        send(ws, { type: "registerSuccess" });
        return;
      }

      if (data.type === "login") {
        const name = String(data.username || "").trim();
        const password = String(data.password || "");

        const r = await db(`SELECT password_hash FROM users WHERE username=$1`, [name]);
        if (!r.rowCount || !verifyPassword(password, r.rows[0].password_hash)) {
          return send(ws, { type: "error", message: "Incorrect username or password." });
        }

        if (clients.has(name)) {
          return send(ws, { type: "error", message: "That account is already online." });
        }

        username = name;
        clients.set(username, ws);

        send(ws, { type: "loginSuccess", username });
        await sendHistory(username);
        broadcastUserList();
        return;
      }

      if (!username) return;

      if (data.type === "privateMessage") {
        const to = String(data.to || "").trim();
        const text = String(data.message || "").trim();

        if (!to || !text || text.length > 4000) return;

        const user = await db(`SELECT 1 FROM users WHERE username=$1`, [to]);
        if (!user.rowCount) return send(ws, { type: "error", message: "That user does not exist." });

        const id = crypto.randomUUID();
        const r = await db(
          `INSERT INTO messages(id,sender,recipient,body)
           VALUES($1,$2,$3,$4)
           RETURNING id,sender,recipient,body,edited,created_at`,
          [id, username, to, text]
        );

        const row = r.rows[0];
        const payload = {
          type: "privateMessage",
          id: row.id,
          from: row.sender,
          to: row.recipient,
          message: row.body,
          edited: row.edited,
          time: row.created_at,
          reactions: []
        };

        notifyPrivate(username, to, payload);
        return;
      }

      if (data.type === "editMessage") {
        const id = String(data.id || "");
        const text = String(data.message || "").trim();
        if (!text || text.length > 4000) return;

        const r = await db(
          `UPDATE messages SET body=$1,edited=true
           WHERE id=$2 AND sender=$3
           RETURNING id,sender,recipient,group_id,body,edited,created_at`,
          [text, id, username]
        );
        if (!r.rowCount) return;

        const m = r.rows[0];
        const payload = { type: "messageEdited", id:m.id, from:m.sender, to:m.recipient, groupId:m.group_id, message:m.body, edited:true, time:m.created_at };

        if (m.group_id) await notifyGroup(m.group_id, payload);
        else notifyPrivate(username, m.recipient, payload);
        return;
      }

      if (data.type === "deleteMessage") {
        const id = String(data.id || "");
        const r = await db(
          `DELETE FROM messages WHERE id=$1 AND sender=$2
           RETURNING id,recipient,group_id`,
          [id, username]
        );
        if (!r.rowCount) return;

        const m = r.rows[0];
        const payload = { type: "messageDeleted", id };

        if (m.group_id) await notifyGroup(m.group_id, payload);
        else notifyPrivate(username, m.recipient, payload);
        return;
      }

      if (data.type === "createGroup") {
        const name = String(data.name || "").trim().slice(0, 40);
        const members = Array.isArray(data.members) ? data.members : [];

        if (!name) return;
        const unique = [...new Set([username, ...members.map(String)])];

        const valid = await db(
          `SELECT username FROM users WHERE username = ANY($1::text[])`,
          [unique]
        );
        const validNames = valid.rows.map(x => x.username);

        const groupId = crypto.randomUUID();

        await db(`INSERT INTO groups(id,name,owner) VALUES($1,$2,$3)`, [
          groupId, name, username
        ]);

        for (const member of validNames) {
          await db(`INSERT INTO group_members(group_id,username) VALUES($1,$2) ON CONFLICT DO NOTHING`, [
            groupId, member
          ]);
        }

        const payload = { type: "groupCreated", group: { id: groupId, name, owner: username } };
        for (const member of validNames) send(clients.get(member), payload);
        send(clients.get(username), payload);
        return;
      }

      if (data.type === "groupMessage") {
        const groupId = String(data.groupId || "");
        const text = String(data.message || "").trim();
        if (!groupId || !text || text.length > 4000) return;
        if (!(await isGroupMember(groupId, username))) return;

        const id = crypto.randomUUID();
        const r = await db(
          `INSERT INTO messages(id,sender,group_id,body)
           VALUES($1,$2,$3,$4)
           RETURNING id,sender,group_id,body,edited,created_at`,
          [id, username, groupId, text]
        );
        const m = r.rows[0];
        const g = await db(`SELECT name FROM groups WHERE id=$1`, [groupId]);

        await notifyGroup(groupId, {
          type:"groupMessage",
          id:m.id,
          from:m.sender,
          groupId:m.group_id,
          groupName:g.rows[0]?.name || "Group",
          message:m.body,
          edited:m.edited,
          time:m.created_at,
          reactions:[]
        });
        return;
      }


      if (data.type === "gameState") {
        const gid = String(data.groupId || "");
        if (!(await isGroupMember(gid, username))) return;
        let game = games.get(gid);
        if (!game) {
          const members = await groupMembers(gid);
          const host = members[0] || username;
          game = { groupId: gid, host, active:false, ended:false, endsAt:0, targetId:null, target:null, players:new Map() };
          games.set(gid, game);
        }
        send(ws, gamePayload(game));
        return;
      }

      if (data.type === "gameJoin") {
        const gid = String(data.groupId || "");
        if (!(await isGroupMember(gid, username))) return;
        let game = games.get(gid);
        if (!game) {
          game = { groupId: gid, host: username, active:false, ended:false, endsAt:0, targetId:null, target:null, players:new Map() };
          games.set(gid, game);
        }
        if (!game.players.has(username)) game.players.set(username, { username, score:0 });
        game.ended = false;
        await broadcastGame(game);
        return;
      }

      if (data.type === "gameStart") {
        const gid = String(data.groupId || "");
        if (!(await isGroupMember(gid, username))) return;
        let game = games.get(gid);
        if (!game) return;
        if (game.host !== username || game.active) return;
        if (!game.players.has(username)) game.players.set(username, { username, score:0 });
        for (const player of game.players.values()) player.score = 0;
        game.active = true;
        game.ended = false;
        game.endsAt = Date.now() + 30000;
        game.targetId = crypto.randomUUID();
        game.target = newTarget();
        await broadcastGame(game);
        setTimeout(() => {
          const current = games.get(gid);
          if (current && current.active && current.endsAt <= Date.now()) endGame(gid);
        }, 30100);
        return;
      }

      if (data.type === "gameHit") {
        const gid = String(data.groupId || "");
        if (!(await isGroupMember(gid, username))) return;
        const game = games.get(gid);
        if (!game || !game.active || !game.players.has(username)) return;
        if (game.targetId !== String(data.targetId || "")) return;
        if (Date.now() >= game.endsAt) {
          await endGame(gid);
          return;
        }
        game.players.get(username).score += 1;
        game.targetId = crypto.randomUUID();
        game.target = newTarget();
        await broadcastGame(game);
        return;
      }

      if (data.type === "typing") {
        const target = String(data.target || "");
        const value = !!data.value;

        if (data.groupId) {
          const gid = String(data.groupId);
          if (!(await isGroupMember(gid, username))) return;
          for (const member of await groupMembers(gid)) {
            if (member !== username) send(clients.get(member), {
              type:"typing", from:username, groupId:gid, value
            });
          }
        } else if (target) {
          send(clients.get(target), {
            type:"typing", from:username, value
          });
        }
        return;
      }

      if (data.type === "read") {
        const id = String(data.id || "");
        const r = await db(`SELECT sender,recipient,group_id FROM messages WHERE id=$1`, [id]);
        if (!r.rowCount) return;
        const m = r.rows[0];

        if (m.group_id) {
          if (!(await isGroupMember(m.group_id, username))) return;
          await notifyGroup(m.group_id, { type:"read", id, by:username });
        } else if (m.recipient === username) {
          send(clients.get(m.sender), { type:"read", id, by:username });
        }
        return;
      }

      if (data.type === "react") {
        const id = String(data.id || "");
        const emoji = String(data.emoji || "").slice(0, 4);
        const r = await db(`SELECT sender,recipient,group_id FROM messages WHERE id=$1`, [id]);
        if (!r.rowCount) return;
        const m = r.rows[0];

        if (m.group_id) {
          if (!(await isGroupMember(m.group_id, username))) return;
        } else if (m.sender !== username && m.recipient !== username) {
          return;
        }

        const existing = await db(
          `SELECT 1 FROM reactions WHERE message_id=$1 AND username=$2`,
          [id, username]
        );

        if (existing.rowCount) {
          await db(`DELETE FROM reactions WHERE message_id=$1 AND username=$2`, [id, username]);
        } else {
          await db(`INSERT INTO reactions(message_id,username,emoji) VALUES($1,$2,$3)`, [id,username,emoji]);
        }

        const rr = await db(`SELECT username,emoji FROM reactions WHERE message_id=$1`, [id]);
        const payload = { type:"reactionUpdate", id, reactions:rr.rows };

        if (m.group_id) await notifyGroup(m.group_id, payload);
        else notifyPrivate(m.sender, m.recipient, payload);
        return;
      }
    } catch (err) {
      console.error(err);
      send(ws, { type:"error", message:"Something went wrong on the server." });
    }
  });

  ws.on("close", () => {
    if (username) {
      clients.delete(username);
      broadcastUserList();
    }
  });
});

setup().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`Priv Chat server running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Database setup failed:", err);
  process.exit(1);
});
