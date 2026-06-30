const endpoints = [
  { method: "GET", path: "/api/health", label: "Health check" },
  { method: "POST", path: "/api/auth/login", label: "Admin/customer login" },
  { method: "GET", path: "/api/staff", label: "Public staff list" },
  { method: "POST", path: "/api/bookings", label: "Create booking" },
  { method: "GET", path: "/api/admin/stats", label: "Admin dashboard stats" },
];

export default function ApiHome() {
  return (
    <main style={{
      minHeight: "100vh",
      margin: 0,
      padding: "48px 20px",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#111827",
      background: "radial-gradient(circle at top left, #ffe4ec 0, transparent 32%), linear-gradient(135deg, #fff7fb 0%, #fff 48%, #fff1f2 100%)",
    }}>
      <section style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderRadius: 999,
          background: "#fff",
          color: "#db2777",
          border: "1px solid #fbcfe8",
          boxShadow: "0 10px 30px rgba(219, 39, 119, .08)",
          fontWeight: 700,
          fontSize: 14,
        }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: "#22c55e", boxShadow: "0 0 0 6px #dcfce7" }} />
          API Online
        </div>

        <div style={{
          marginTop: 24,
          padding: "40px",
          borderRadius: 32,
          background: "rgba(255,255,255,.82)",
          border: "1px solid #fce7f3",
          boxShadow: "0 24px 80px rgba(190, 24, 93, .12)",
          backdropFilter: "blur(14px)",
        }}>
          <p style={{ margin: 0, color: "#be185d", fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase", fontSize: 12 }}>
            The Nail Lounge @ Stokesley
          </p>
          <h1 style={{ margin: "12px 0 10px", fontSize: "clamp(38px, 6vw, 72px)", lineHeight: 1, letterSpacing: "-.06em" }}>
            NailBooking Backend API
          </h1>
          <p style={{ margin: 0, maxWidth: 720, color: "#6b7280", fontSize: 18, lineHeight: 1.7 }}>
            Dedicated backend for booking, staff, services, admin statistics and authentication. Frontend production domain is wired to this API.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginTop: 32 }}>
            <div style={{ padding: 20, borderRadius: 24, background: "linear-gradient(135deg, #ec4899, #fb7185)", color: "white" }}>
              <div style={{ fontSize: 13, opacity: .86, fontWeight: 700 }}>Frontend</div>
              <div style={{ marginTop: 8, fontSize: 18, fontWeight: 900 }}>bookingnail.overpowers.agency</div>
            </div>
            <div style={{ padding: 20, borderRadius: 24, background: "#111827", color: "white" }}>
              <div style={{ fontSize: 13, opacity: .7, fontWeight: 700 }}>Database</div>
              <div style={{ marginTop: 8, fontSize: 18, fontWeight: 900 }}>PostgreSQL · nailbooking-db</div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
          {endpoints.map((endpoint) => (
            <div key={endpoint.path} style={{
              display: "grid",
              gridTemplateColumns: "90px 1fr 1.2fr",
              gap: 14,
              alignItems: "center",
              padding: "16px 18px",
              borderRadius: 18,
              background: "rgba(255,255,255,.9)",
              border: "1px solid #fce7f3",
            }}>
              <code style={{ color: endpoint.method === "GET" ? "#047857" : "#be185d", fontWeight: 900 }}>{endpoint.method}</code>
              <code style={{ color: "#374151", fontWeight: 800 }}>{endpoint.path}</code>
              <span style={{ color: "#6b7280" }}>{endpoint.label}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
