import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const bubbleVariants = cva(
  "inline-flex max-w-[80%] items-start gap-2 rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border border-border bg-background",
        subtle: "bg-muted text-foreground",
      },
      align: {
        start: "rounded-bl-sm",
        end: "rounded-br-sm",
      },
    },
    defaultVariants: {
      variant: "outline",
      align: "start",
    },
  }
);

function Bubble({ className, variant, align, ...props }) {
  return (
    <div
      data-slot="bubble"
      className={cn(bubbleVariants({ variant, align, className }))}
      {...props}
    />
  );
}

export { Bubble, bubbleVariants };
