/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        spinIn: {
          "0%": { transform: "translateY(-100%) scale(1.2)", opacity: "0" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        bounceIn: {
          "0%, 20%, 40%, 60%, 80%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" }
        },
        "coin-flip": {
          "0%": { transform: "rotateY(0)" },
          "100%": { transform: "rotateY(1440deg)" }
        },
        spinReel: {
          "0%": { transform: "translateY(-50%)", opacity: "0.5" },
          "100%": { transform: "translateY(0)", opacity: "1" }
        }
      },
      animation: {
        spinIn: "spinIn 0.4s ease-out",
        fadeIn: "fadeIn 0.5s ease-in-out",
        bounceIn: "bounceIn 1s ease",
        "coin-flip": "coin-flip 1s ease-in-out",
        spinReel: "spinReel 0.3s ease-out"
      }
    }
  },
  plugins: []
};
