/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      keyframes: {
        spinIn: {
          "0%": { transform: "translateY(-100%) scale(1.2)", opacity: "0" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
      },
      animation: {
        spinIn: "spinIn 0.3s ease-out",
      },
    },
  },
};




