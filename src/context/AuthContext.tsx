"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface User { id: string; email: string; name: string; role: string; }
interface AuthCtx { user: User | null; login: (email: string, password: string) => Promise<void>; register: (data: any) => Promise<void>; logout: () => void; loading: boolean; }

const AuthContext = createContext<AuthCtx | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(d => { if (d.user) setUser(d.user); }).finally(() => setLoading(false));
    } else setLoading(false);
  }, []);

  const login = async (email: string, password: string) => {
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    localStorage.setItem("token", d.token);
    setUser(d.user);
  };

  const register = async (data: any) => {
    const r = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
  };

  const logout = () => { localStorage.removeItem("token"); setUser(null); window.location.href = "/"; };

  return <AuthContext.Provider value={{ user, login, register, logout, loading }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => { const ctx = useContext(AuthContext); if (!ctx) throw new Error("useAuth must be in AuthProvider"); return ctx; };
