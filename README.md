# Priv Chat upgraded

Features:
- Accounts stored in PostgreSQL
- Strong password hashing with Node scrypt
- Private messages
- Group chats
- Typing indicators
- Read receipts
- Reactions
- Edit/delete messages
- Online users
- Emoji picker
- Browser notifications
- Responsive UI

## Render setup

Create a PostgreSQL database on Render, then add its connection string as:

DATABASE_URL=your_postgres_connection_string

For the Web Service:
- Build Command: npm install
- Start Command: npm start

For the Static Site:
- Publish Directory: .
- No build command

IMPORTANT:
The HTML uses the current backend URL:
wss://priv-chat1.onrender.com

If your backend URL changes, edit `wsUrl` in index.html.
