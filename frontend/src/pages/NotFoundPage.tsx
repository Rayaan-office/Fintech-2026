import { CompassIcon } from "lucide-react";
import { Link } from "react-router";
import { IconTile } from "@/components/kit";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <IconTile icon={CompassIcon} className="mb-4 size-11 [&>svg]:size-5" />
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">The link may be old, or the page has moved.</p>
      <Button asChild variant="secondary" className="mt-5">
        <Link to="/">Go to Home</Link>
      </Button>
    </div>
  );
}
