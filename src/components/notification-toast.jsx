"use client";
import React from "react";



export default function Index() {
  return (function MainComponent({ 
  message, 
  type = "info", 
  duration = 5000, 
  onClose,
  isVisible = true 
}) {
  const [show, setShow] = useState(isVisible);

  useEffect(() => {
    setShow(isVisible);
  }, [isVisible]);

  useEffect(() => {
    if (show && duration) {
      const timer = setTimeout(() => {
        setShow(false);
        onClose?.();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [show, duration, onClose]);

  if (!show) return null;

  const baseStyles = "fixed top-4 right-4 z-50 flex items-center justify-between rounded-lg p-4 shadow-lg transition-all duration-300 transform";
  const typeStyles = {
    success: "bg-green-500 text-white",
    error: "bg-red-500 text-white",
    info: "bg-blue-500 text-white",
    warning: "bg-yellow-500 text-white"
  };

  const icons = {
    success: "fa-check-circle",
    error: "fa-exclamation-circle",
    info: "fa-info-circle",
    warning: "fa-exclamation-triangle"
  };

  return (
    <div className={`${baseStyles} ${typeStyles[type]}`}>
      <div className="flex items-center space-x-2">
        <i className={`fas ${icons[type]}`}></i>
        <span className="text-sm font-medium">{message}</span>
      </div>
      <button
        onClick={() => {
          setShow(false);
          onClose?.();
        }}
        className="ml-4 text-white hover:text-gray-200 focus:outline-none"
      >
        <i className="fas fa-times"></i>
      </button>
    </div>
  );
}

function StoryComponent() {
  const [showSuccess, setShowSuccess] = useState(true);
  const [showError, setShowError] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  const [showWarning, setShowWarning] = useState(true);

  return (
    <div className="space-y-4 p-4">
      <h2 className="mb-4 text-xl font-bold">Notification Toast Examples</h2>
      
      <div className="space-y-2">
        <MainComponent
          message="Opération réussie !"
          type="success"
          isVisible={showSuccess}
          onClose={() => setShowSuccess(false)}
        />

        <MainComponent
          message="Une erreur est survenue"
          type="error"
          isVisible={showError}
          onClose={() => setShowError(false)}
        />

        <MainComponent
          message="Information importante"
          type="info"
          isVisible={showInfo}
          onClose={() => setShowInfo(false)}
        />

        <MainComponent
          message="Attention requise"
          type="warning"
          isVisible={showWarning}
          onClose={() => setShowWarning(false)}
        />
      </div>

      <div className="mt-8 space-x-4">
        <button
          onClick={() => setShowSuccess(true)}
          className="rounded bg-green-500 px-4 py-2 text-white hover:bg-green-600"
        >
          Show Success
        </button>
        <button
          onClick={() => setShowError(true)}
          className="rounded bg-red-500 px-4 py-2 text-white hover:bg-red-600"
        >
          Show Error
        </button>
        <button
          onClick={() => setShowInfo(true)}
          className="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
        >
          Show Info
        </button>
        <button
          onClick={() => setShowWarning(true)}
          className="rounded bg-yellow-500 px-4 py-2 text-white hover:bg-yellow-600"
        >
          Show Warning
        </button>
      </div>
    </div>
  );
});
}