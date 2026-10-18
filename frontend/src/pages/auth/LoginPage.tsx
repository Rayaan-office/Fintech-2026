import { Loader2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { useLogin } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/states";
import { AuthLayout } from "./AuthLayout";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: (res) => {
          if (res.totp_setup_required) navigate("/sign-in/two-step?setup=1", { replace: true, state: { from } });
          else if (res.totp_required) navigate("/sign-in/two-step", { replace: true, state: { from } });
          else navigate(from ?? "/", { replace: true });
        },
        onError: () => setPassword(""),
      },
    );
  };

  return (
    <AuthLayout title="Sign in" description="Welcome back.">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate={false}>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <FormError message={login.isError ? errorMessage(login.error) : null} />
        <Button type="submit" size="lg" className="mt-1" disabled={login.isPending || !email || !password}>
          {login.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
