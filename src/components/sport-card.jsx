"use client";
import React from "react";



export default function Index() {
  function MainComponent({ icon, name, onClick }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center space-x-3 rounded-lg border border-[#FFD700] bg-[#004080] px-6 py-4 shadow-lg shadow-[#FFD700]/20 transition-all hover:bg-[#004080]/90 hover:shadow-[#FFD700]/20"
    >
      <i className={`fas ${icon} text-2xl text-[#FFD700]`}></i>
      <span className="text-lg font-medium text-[#FFD700]">{name}</span>
    </button>
  );
    function StoryComponent() {
      return (
        <div className="space-y-8 bg-[#004080] p-8">
          <div>
            <h2 className="mb-4 text-lg font-bold text-[#FFD700]">Sport Card - Football</h2>
            <MainComponent
              icon="fa-futbol"
              name="Football"
              onClick={() => console.log('Football clicked')}
            />
          </div>
  
          <div>
            <h2 className="mb-4 text-lg font-bold text-[#FFD700]">Sport Card - Basketball</h2>
            <MainComponent
              icon="fa-basketball-ball"
              name="Basketball"
              onClick={() => console.log('Basketball clicked')}
            />
          </div>
  
          <div>
            <h2 className="mb-4 text-lg font-bold text-[#FFD700]">Sport Card - Tennis</h2>
            <MainComponent
              icon="fa-tennis-ball"
              name="Tennis"
              onClick={() => console.log('Tennis clicked')}
            />
          </div>
  
          <style jsx global>{`
            @keyframes glow {
              0% {
                box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
              50% {
                box-shadow: 0 0 20px rgba(255, 215, 0, 0.2);
              100% {
                box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
              }
            }
  
            button:hover {
              animation: glow 2s infinite;
            }
          `}</style>
        </div>
      );
    }
  
    return <StoryComponent />;
  }
}

function StoryComponent() {
  return (
    <div className="space-y-8 bg-[#004080] p-8">
      <div>
        <h2 className="mb-4 text-lg font-bold text-[#FFD700]">Sport Card - Football</h2>
        <MainComponent
          icon="fa-futbol"
          name="Football"
          onClick={() => console.log('Football clicked')}
        />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-bold text-[#FFD700]">Sport Card - Basketball</h2>
        <MainComponent
          icon="fa-basketball-ball"
          name="Basketball"
          onClick={() => console.log('Basketball clicked')}
        />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-bold text-[#FFD700]">Sport Card - Tennis</h2>
        <MainComponent
          icon="fa-tennis-ball"
          name="Tennis"
          onClick={() => console.log('Tennis clicked')}
        />
      </div>

      <style jsx global>{`
        @keyframes glow {
          0% {
            box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
          }
          50% {
            box-shadow: 0 0 20px rgba(255, 215, 0, 0.2);
          }
          100% {
            box-shadow: 0 0 5px rgba(255, 215, 0, 0.1);
          }
        }

        button:hover {
          animation: glow 2s infinite;
        }
      `}</style>
    </div>
  );
}

return <StoryComponent />;
