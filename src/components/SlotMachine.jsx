import React, { useState } from 'react';

const fruitIcons = [
  🍓,
  🍊,
  🍌,
  🫐,
  🍋,
  🥑,
  🍐
  🍒,
];

const getRandomFruit = () => {
  const index = Math.floor(Math.random() * fruitIcons.length);
  return fruitIcons[index];
};

const SlotMachine = () => {
  const [reels, setReels] = useState(
    Array.from({ length: 5 }, () => Array(3).fill('/fruits/question.png'))
  );

  const spin = () => {
    const newReels = Array.from({ length: 5 }, () =>
      Array.from({ length: 3 }, () => getRandomFruit())
    );
    setReels(newReels);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-purple-900 to-indigo-900 p-4">
      {/* Reels */}
      <div className="flex border-8 border-yellow-400 rounded-xl bg-purple-700 p-4 mb-6">
        {reels.map((column, colIdx) => (
          <div key={colIdx} className="flex flex-col items-center mx-1 bg-purple-900 p-2 rounded-lg">
            {column.map((fruit, rowIdx) => (
              <img
                key={rowIdx}
                src={fruit}
                alt="fruit"
                className="w-16 h-16 my-1 rounded"
              />
            ))}
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4">
        <button
          onClick={spin}
          className="bg-red-500 hover:bg-red-600 text-white text-xl font-bold py-3 px-8 rounded-full shadow-lg transition"
        >
          SPIN
        </button>
        <button className="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold py-2 px-6 rounded shadow">
          AUTO SPIN
        </button>
        <button className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow">
          MAX BET
        </button>
      </div>

      {/* Info */}
      <div className="flex mt-6 space-x-6 text-white">
        <div>
          <div className="text-sm">BET:</div>
          <div className="font-bold text-lg">100</div>
        </div>
        <div>
          <div className="text-sm">TOTAL BET:</div>
          <div className="font-bold text-lg">500.5</div>
        </div>
        <div>
          <div className="text-sm">WIN:</div>
          <div className="font-bold text-lg text-green-400">122,300,457</div>
        </div>
      </div>
    </div>
  );
};

export default SlotMachine;
