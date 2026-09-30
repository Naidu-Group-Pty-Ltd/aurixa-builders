import { useWhiteLabel } from "@/contexts/WhiteLabelContext"
import { Toaster as Sonner, toast } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { themeMode } = useWhiteLabel()

  return (
    <Sonner
      theme={themeMode as ToasterProps["theme"]}
      className="toaster group"
      // A pop-up that stays twelve seconds over the page must be closable
      // before then — the Command Centre's has always had this.
      closeButton
      toastOptions={{
        closeButton: true,
        classNames: {
          toast:
            "group toast luxury-toast group-[.toaster]:text-foreground",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:border-border group-[.toast]:bg-card group-[.toast]:text-foreground group-[.toast]:opacity-100 group-[.toast]:hover:bg-muted",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
