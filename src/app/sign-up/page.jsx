function MainComponent() {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const { signUpWithCredentials } = useAuth();

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!email || !password) {
      setError("Veuillez remplir tous les champs");
      setLoading(false);
      return;
    }

    try {
      await signUpWithCredentials({
        email,
        password,
        callbackUrl: "/",
        redirect: false,
      });

      await fetch("/api/initialize-user-tokens", {
        method: "POST",
      });

      window.location.href = "/";
    } catch (err) {
      const errorMessages = {
        OAuthSignin:
          "Impossible de démarrer l'inscription. Veuillez réessayer.",
        OAuthCallback:
          "Échec de l'inscription après redirection. Veuillez réessayer.",
        OAuthCreateAccount:
          "Impossible de créer un compte avec cette option. Essayez-en une autre.",
        EmailCreateAccount:
          "Cet email ne peut pas être utilisé. Il est peut-être déjà enregistré.",
        Callback:
          "Une erreur s'est produite lors de l'inscription. Veuillez réessayer.",
        OAuthAccountNotLinked:
          "Ce compte est lié à une autre méthode de connexion. Essayez celle-ci.",
        CredentialsSignin:
          "Email ou mot de passe invalide. Si vous avez déjà un compte, essayez de vous connecter.",
        AccessDenied: "Vous n'avez pas la permission de vous inscrire.",
        Configuration:
          "L'inscription ne fonctionne pas pour le moment. Veuillez réessayer plus tard.",
        Verification:
          "Votre lien d'inscription a expiré. Demandez-en un nouveau.",
      };

      setError(
        errorMessages[err.message] ||
          "Une erreur s'est produite. Veuillez réessayer.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-[#003366] p-4">
      <form
        noValidate
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-2xl border border-[#FFD700] bg-[#003366] p-8 shadow-xl"
      >
        <h1 className="mb-2 text-center text-3xl font-bold text-[#FFD700]">
          Inscription
        </h1>
        <p className="mb-8 text-center text-sm text-gray-300">
          Créez votre compte et recevez 1000 jetons gratuits !
        </p>

        <div className="space-y-6">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[#FFD700]">
              Email
            </label>
            <div className="overflow-hidden rounded-lg border border-[#FFD700] bg-[#004080] px-4 py-3 focus-within:ring-1 focus-within:ring-[#FFD700]">
              <input
                required
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Entrez votre email"
                className="w-full bg-transparent text-lg text-white outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[#FFD700]">
              Mot de passe
            </label>
            <div className="overflow-hidden rounded-lg border border-[#FFD700] bg-[#004080] px-4 py-3 focus-within:ring-1 focus-within:ring-[#FFD700]">
              <input
                required
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg bg-transparent text-lg text-white outline-none placeholder:text-gray-400"
                placeholder="Entrez votre mot de passe"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-900/20 p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#FFD700] px-4 py-3 text-base font-medium text-[#003366] transition-colors hover:bg-[#FFD700]/80 focus:outline-none focus:ring-2 focus:ring-[#FFD700] focus:ring-offset-2 disabled:opacity-50"
          >
            {loading ? "Inscription en cours..." : "S'inscrire"}
          </button>
          <p className="text-center text-sm text-gray-300">
            Déjà un compte ?{" "}
            <a
              href="/account/signin"
              className="text-[#FFD700] hover:text-[#FFD700]/80"
            >
              Connectez-vous
            </a>
          </p>
        </div>
      </form>
    </div>
  );
}
