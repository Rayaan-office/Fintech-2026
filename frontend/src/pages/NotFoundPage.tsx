import { CompassIcon } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <EmptyState
      icon={CompassIcon}
      title="We couldn't find that page"
      description="The link may be old, or the page has moved."
      action={
        <Button asChild variant="secondary">
          <Link to="/">Go to Home</Link>
        </Button>
      }
    />
  );
}
