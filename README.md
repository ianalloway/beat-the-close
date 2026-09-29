# Beat the Close

A live betting-market party game for 2–8 players. Play it at **https://ianalloway.github.io/beat-the-close/**

Each player gets a private scouting read on a made-up matchup and bets into one shared line. Every bet moves the line, and off-screen sharp money pulls it toward the hidden true chance as the clock runs. Bet early for a better price, or wait and read the market. You win by having the most chips, but the reveal also shows who beat the closing line. That's closing line value (CLV), the number pros use to tell skill from luck.

The teams are named after the rivers around Fairmont, West Virginia, where the Tygart Valley and the West Fork meet to form the Monongahela.

## How to play

1. One person opens the site and clicks **Create table**. Their device becomes the table.
2. Everyone else scans the QR code or opens the link, then types their name.
3. The host presses **Start**. There are 6 rounds of 40 seconds each, 3 bets max per round, and each bet is 1–25% of your chips.
4. After 6 rounds the player with the most chips wins, and the player with the best total CLV gets the Sharpest award.

The full rules are in the game under **?**.

## How it works

- It's a static site with no server of its own and no sign-up. Devices talk through a public MQTT relay over secure WebSockets (HiveMQ, with EMQX as a fallback).
- The host's browser is the authority. It holds the true chance, runs the clock, validates every bet and broadcasts the public state. Players never receive the true chance before the reveal.
- Scouting reads and bets are end-to-end encrypted per player with ECDH P-256 and AES-GCM. Nobody watching the relay can read someone else's read or place a bet in their name, and replayed messages are rejected.
- Refreshing is safe. The host's table state and each player's identity are saved in the tab. A player on a new device can take back their seat by joining with the same name, as long as the old one has gone quiet.
- The bet ticket shows your edge against the line and a Kelly-criterion stake, with a one-tap half-Kelly option.

It's plain HTML, CSS and JavaScript with no build step. mqtt.js, qrcode-generator and the fonts are vendored.
