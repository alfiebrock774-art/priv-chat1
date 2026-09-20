PRIV CHAT GROUP BATTLE

This version adds a multiplayer Group Battle mini-game.

How it works:
- Open a group and press 🎮 Game.
- Each player presses Join Game.
- The group host presses Start Round.
- The round lasts 30 seconds.
- Click/tap the moving 🎯 target to score.
- Scores and the leaderboard update for everyone in the group.
- Works with mouse/keyboard and touch screens.
- Game state is held in the server memory and resets if the server restarts.

Deployment:
1. Replace your existing index.html and server.js with these files.
2. Save them in C:\Users\paulb\Downloads\priv chat
3. In PowerShell run:
   cd "$env:USERPROFILE\Downloads\priv chat"
   git add index.html server.js
   git commit -m "Add multiplayer Group Battle"
   git push origin main
4. Render should automatically redeploy.
