# 🎰 GoonBet — The Next-Gen Online Casino  

Welcome to **GoonBet**, a modern online casino and sports betting platform where users can play with **tokens** in a fun, fair, and engaging way.  

Our platform is designed to combine classic casino games with a smooth, interactive experience that works on desktop and mobile.  

---

## 🚀 Features

- 🎲 **Casino Games** — Blackjack, Poker, Roulette, Keno, rock paper scissors, crash, mines, uno and more (token-based)
- 📊 **Sports Betting** — Soccer, Basketball, MMA, E-Sports, and more  
- 🏆 **Token System** — Play-for-fun mode so users can practice without losing real money  
- 🔑 **Clerk Authentication** — Secure user sign-up and login  
- 💰 **Wallet & Token Management** — Seamless token balance updates via secure API routes  
- 📱 **Mobile-Friendly UI** — Optimized for a smooth experience on any device  
- 🛡 **Security First** — SQL injection protection, CSRF tokens, rate limiting, and TLS  

---

## 🖼️ Preview  
![Casino Screenshot](./public/demo-preview.png)  
_A preview of the main lobby interface (Roulette + Blackjack shown)_

---

## 🛠️ Tech Stack

| Layer            | Technology |
|-----------------|------------|
| **Frontend**    | Next.js 16.15, React 19.1, TailwindCSS |
| **Backend**     | Next.js API Routes, Neon Postgres |
| **Auth**        | Clerk (JWTs + OAuth) |
| **Database**    | Neon DB + Drizzle ORM |
| **Hosting**     | Vercel |



---

## 🔐 Environment Setup

1. Copy `.env.example` to `.env.local`.
2. Fill all values with your own secrets.
3. Never commit `.env.local` or production keys.
4. If secrets were previously exposed, rotate them immediately in the provider dashboards.
