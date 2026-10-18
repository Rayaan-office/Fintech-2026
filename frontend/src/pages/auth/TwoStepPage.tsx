import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useLogout, useTotpSetup, useTotpVerify } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/states";
import { AuthLayout } from "./AuthLayout";

export function TwoStepPage() {
  const [params] = useSearchParams();
  const setup = params.get("setup") === "1";
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const verify = useTotpVerify();
  const logout = useLogout();
  const [code, setCode] = useState("");

  const submit = (value: string) => {
    if (value.length !== 6 || verify.isPending) return;
    verify.mutate(value, {
      onSuccess: () => navigate(from ?? "/", { replace: true }),
      onError: () => setCode(""),
    });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(code);
  };

  return (
    <AuthLayout
      title={setup ? "Set up two-step sign-in" : "Two-step sign-in"}
      description={
        setup
          ? "Approvers sign in with an authenticator app code too."
          : "Enter the 6-digit code from your authenticator app."
      }
    >
      {setup && <SetupStep />}
      <form onSubmit={onSubmit} className="grid gap-4">
        <div className="grid gap-2">
          {setup ? (
            <Label htmlFor="code" className="flex items-center gap-2">
              <StepNumber n={3} /> Enter the 6-digit code
            </Label>
          ) : (
            <Label htmlFor="code">Code</Label>
          )}
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            autoFocus={!setup}
            required
            value={code}
            className="text-center font-mono text-lg tracking-[0.4em]"
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(digits);
              if (digits.length === 6) submit(digits);
            }}
          />
        </div>
        <FormError message={verify.isError ? errorMessage(verify.error) : null} />
        <Button type="submit" size="lg" disabled={code.length !== 6 || verify.isPending}>
          {verify.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
          Continue
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Not you?{" "}
          <Link
            to="/sign-in"
            className="font-medium text-primary hover:underline"
            onClick={(e) => {
              e.preventDefault();
              logout.mutate(undefined, { onSettled: () => navigate("/sign-in", { replace: true }) });
            }}
          >
            Use a different account
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

function SetupStep() {
  const setup = useTotpSetup(true);
  const [copied, setCopied] = useState(false);

  if (setup.isPending) {
    return (
      <div className="mb-6 grid justify-items-center gap-3" aria-busy="true">
        <Skeleton className="size-44" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }
  if (setup.isError) {
    return (
      <div className="mb-6">
        <FormError message={errorMessage(setup.error)} />
      </div>
    );
  }

  const { otpauth_uri, secret } = setup.data;
  const grouped = secret.replace(/(.{4})/g, "$1 ").trim();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <ol className="mb-6 grid gap-5 text-sm">
      <li className="grid gap-3">
        <Step n={1}>Scan with your authenticator app</Step>
        <div className="flex justify-center rounded-xl border bg-white p-4">
          <QRCodeSVG value={otpauth_uri} size={168} marginSize={0} title="QR code for your authenticator app" />
        </div>
      </li>
      <li className="grid gap-2">
        <Step n={2}>
          Or type this key <span className="font-normal text-muted-foreground">(shown once)</span>
        </Step>
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <code className="flex-1 break-all font-mono text-[13px]" aria-label="Setup key">
            {grouped}
          </code>
          <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={copied ? "Copied" : "Copy key"}>
            {copied ? <CheckIcon className="text-positive" aria-hidden /> : <CopyIcon aria-hidden />}
          </Button>
        </div>
      </li>
    </ol>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular" aria-hidden>
      {n}
    </span>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 font-medium">
      <StepNumber n={n} />
      <span>{children}</span>
    </p>
  );
}
