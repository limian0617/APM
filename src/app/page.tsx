export default function HomePage() {
  return (
    <main className="foundation-page">
      <section className="foundation-panel" aria-labelledby="foundation-title">
        <p className="foundation-kicker">APM ENGINEERING FOUNDATION</p>
        <h1 id="foundation-title">Automatic Project Management</h1>
        <p>
          The engineering foundation is ready. Product modules start with APM-002: identity,
          authorization, and project membership.
        </p>
        <a href="/api/health">Service health</a>
      </section>
    </main>
  );
}
