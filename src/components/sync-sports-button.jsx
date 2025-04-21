"use client";
import React from "react";



export default function Index() {
  return (function MainComponent({ onSync }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const handleSync = async () => {
    setLoading(true);
    setStatus('syncing');
    setError(null);

    try {
      const response = await fetch('/api/sync-sports-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ retryCount }),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error);
      }

      setStatus('success');
      if (onSync) onSync(data);
    } catch (err) {
      setError(err.message);
      setStatus('error');
      setRetryCount((prev) => prev + 1);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="inline-block">
      {status !== 'error' && (
        <button
          onClick={handleSync}
          disabled={loading}
          className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors
            ${loading 
              ? 'bg-[#FFD700]/50 text-[#003366] cursor-not-allowed' 
              : 'bg-[#FFD700] text-[#003366] hover:bg-[#FFD700]/80'
            }`}
        >
          {loading && (
            <i className="fas fa-spinner fa-spin mr-2"></i>
          )}
          {loading ? 'Synchronisation...' : 'Synchroniser les données'}
        </button>
      )}

      {status === 'error' && (
        <div className="space-y-2">
          <p className="text-sm text-red-500">
            {error} (Tentative {retryCount})
          </p>
          <button
            onClick={handleSync}
            className="inline-flex items-center justify-center rounded-md border border-[#FFD700] bg-transparent px-4 py-2 text-sm font-medium text-[#FFD700] transition-colors hover:bg-[#FFD700] hover:text-[#003366]"
          >
            Réessayer
          </button>
        </div>
      )}

      {status === 'success' && (
        <p className="mt-2 text-sm text-green-500">
          Synchronisation réussie!
        </p>
      )}
    </div>
  );
}

function StoryComponent() {
  return (
    <div className="space-y-8 bg-black p-8">
      <div>
        <h3 className="mb-4 text-white">État par défaut</h3>
        <MainComponent onSync={(data) => console.log('Sync complete:', data)} />
      </div>

      <div>
        <h3 className="mb-4 text-white">État de chargement</h3>
        <MainComponent loading={true} />
      </div>

      <div>
        <h3 className="mb-4 text-white">État d'erreur</h3>
        <MainComponent error="Erreur de synchronisation" retryCount={2} />
      </div>

      <div>
        <h3 className="mb-4 text-white">État de succès</h3>
        <MainComponent success={true} />
      </div>
    </div>
  );
});
}