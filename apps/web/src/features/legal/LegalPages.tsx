import { useMutation } from "@tanstack/react-query";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/features/auth/auth-context";
import { api, errorMessage } from "@/lib/api";

const COMPANY = "Vibhav Enterprise Solutions";
const SUPPORT_PHONE = "94449 07658";
const SUPPORT_EMAIL = "info@sasvatamobility.com";
const UPDATED = "24 October 2026";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  const { status } = useAuth();
  const signedIn = status === "authenticated";
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <Link
            to={signedIn ? "/" : "/login"}
            className="flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <ArrowLeftIcon className="size-4" />{" "}
            {signedIn ? t("Back to VeeTrax") : t("Sign in")}
          </Link>
          <Logo />
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 text-sm leading-relaxed">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children}
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="space-y-2 p-5">
      <h2 className="text-base font-semibold text-primary">{title}</h2>
      {children}
    </Card>
  );
}

/** One app's part of the privacy policy; the id is the anchor each store listing links to (/privacy#veetrax, /privacy#tracker). */
function AppPart({
  id,
  title,
  pkg,
  children,
}: {
  id: string;
  title: string;
  pkg: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3 pt-2">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground">Android app {pkg}</p>
      </div>
      {children}
    </section>
  );
}

/** Public privacy policy for the VeeTrax and VeeTrax Tracker apps and app.veetrax.com (linked from the stores and the apps). */
export function PrivacyPage() {
  return (
    <Shell title="Privacy policy">
      <p className="text-muted-foreground">
        This policy covers two apps and the website app.veetrax.com, all
        provided by {COMPANY}, Chennai, India. Last updated {UPDATED}.
      </p>
      <ul className="list-disc space-y-1 ps-5">
        <li>
          <a className="text-primary underline" href="#veetrax">
            VeeTrax
          </a>{" "}
          – the app and website to see your vehicles, phones and dashcams on the
          map.
        </li>
        <li>
          <a className="text-primary underline" href="#tracker">
            VeeTrax Tracker
          </a>{" "}
          – the app that shares a phone's location with a VeeTrax account.
        </li>
        <li>
          <a className="text-primary underline" href="#common">
            Both apps
          </a>{" "}
          – sharing, retention, deletion, security and contact.
        </li>
      </ul>

      <AppPart
        id="veetrax"
        title="VeeTrax app and app.veetrax.com"
        pkg="com.sasvata.veetrax"
      >
        <Section title="What VeeTrax collects">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              <b>Account details:</b> name, e-mail address, mobile number,
              password (stored only as a secure hash), and for billing your
              name, state and GST details.
            </li>
            <li>
              <b>Data of your tracked devices:</b> positions, speed, heading,
              ignition and sensor readings, trips and alerts sent by the GPS
              trackers, dashcams and phones in your account, and the names,
              groups, geofences and settings you enter.
            </li>
            <li>
              <b>Your phone's location:</b> only while the app is open, and only
              if you allow it, to show where you are on the map. It is not sent
              to our servers or stored.
            </li>
            <li>
              <b>Usage:</b> sign-ins, alerts you receive and settings you change
              (audit log), and the push-notification token of your phone.
            </li>
          </ul>
        </Section>
        <Section title="Why VeeTrax uses it">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              To show the live location, history, trips, reports and alerts to
              the account that owns the device, and to the users that account
              allows.
            </li>
            <li>To send alerts (push, SMS, e-mail) and sign-in codes.</li>
            <li>To bill for licences and send GST invoices.</li>
            <li>
              To keep the service secure and working, and to fix problems.
            </li>
          </ul>
        </Section>
      </AppPart>

      <AppPart
        id="tracker"
        title="VeeTrax Tracker app"
        pkg="com.sasvata.veetrax.tracker"
      >
        <Section title="What VeeTrax Tracker collects">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              <b>Precise location, also in the background:</b> the phone's
              position, speed, heading and accuracy,{" "}
              <b>also when the app is closed or not in use</b>. Collection
              starts only after the phone is activated and the user taps Start
              tracking and allows location, and stops when the user taps Stop. A
              permanent notification shows the whole time it tracks.
            </li>
            <li>
              <b>Account details:</b> the phone's mobile number, the e-mail
              address and the optional name entered at activation.
            </li>
            <li>
              <b>SOS:</b> when you hold the SOS button, an alert with your
              location.
            </li>
            <li>
              <b>Phone information:</b> battery level, phone model and Android
              version, whether location, notification and battery-saver
              permissions are allowed, and crash reports (no location or
              personal data in crash reports).
            </li>
          </ul>
        </Section>
        <Section title="Why VeeTrax Tracker uses it">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              To show the phone's location, history and alerts in the VeeTrax
              account it was activated for (your own, your family's or your
              employer's), and to the users that account allows.
            </li>
            <li>To send activation codes and SOS alerts.</li>
            <li>
              To find out why tracking stopped on a phone (for example a battery
              saver) and help you fix it.
            </li>
          </ul>
        </Section>
        <Section title="Consent for tracking people">
          <p>
            A phone is tracked only after its user activates VeeTrax Tracker on
            that phone with a code sent to that number, or confirms with an SMS
            code when a family member adds them. The app shows which account
            receives the location. Tracking can be stopped at any time in the
            app (Stop, or Sign out / deactivate). Use VeeTrax to track a person
            only with their knowledge and consent, and in line with the law.
          </p>
        </Section>
      </AppPart>

      <section id="common" className="scroll-mt-20 space-y-3 pt-2">
        <h2 className="text-xl font-semibold tracking-tight">Both apps</h2>
        <Section title="No selling, no advertising">
          <p>
            We do not sell personal data and do not use it for advertising.
            Neither app contains ads or advertising IDs.
          </p>
        </Section>
        <Section title="Who we share it with">
          <p>
            Only service providers that help run VeeTrax, under their own
            privacy terms:
          </p>
          <ul className="list-disc space-y-1 ps-5">
            <li>
              SMS delivery (Smartping) for codes and SMS alerts; e-mail delivery
              (Zoho ZeptoMail).
            </li>
            <li>
              Push notifications (Google Firebase Cloud Messaging / Expo).
            </li>
            <li>
              Hosting of our servers; addresses are looked up on our own map
              server (OpenStreetMap data).
            </li>
          </ul>
          <p>We disclose data to authorities only when the law requires it.</p>
        </Section>
        <Section title="How long we keep it">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              Location history: as set for the account (30 to 180 days, 90 by
              default), then deleted automatically.
            </li>
            <li>Raw device data: 7 days. Encrypted backups: up to 100 days.</li>
            <li>Invoices: as long as tax law requires.</li>
            <li>
              Everything else: until you delete the device or the account.
            </li>
          </ul>
        </Section>
        <Section title="Your choices and rights">
          <ul className="list-disc space-y-1 ps-5">
            <li>
              View and correct your details in Profile; stop tracking any time
              in VeeTrax Tracker.
            </li>
            <li>
              <b>Delete your account and data:</b> in the VeeTrax app (Profile →
              Delete account) or at{" "}
              <Link className="text-primary underline" to="/delete-account">
                app.veetrax.com/delete-account
              </Link>
              . VeeTrax Tracker users: your phone belongs to the VeeTrax account
              of your e-mail or mobile number; sign in there with an OTP to
              delete it. To only stop sharing, tap Sign out / deactivate in the
              Tracker.
            </li>
            <li>
              Ask us what data we hold about you, or for help, using the contact
              below.
            </li>
          </ul>
        </Section>
        <Section title="Security">
          <p>
            Data is sent over encrypted connections (HTTPS), passwords are
            stored as hashes, access is limited by roles, and backups are
            encrypted. No system is perfectly secure; tell us at once if you
            notice a problem.
          </p>
        </Section>
        <Section title="Children">
          <p>
            VeeTrax is not directed at children. Accounts are created by adults;
            a child's phone may be tracked only by their parent or guardian.
          </p>
        </Section>
        <Section title="Contact">
          <p>
            {COMPANY} · Support: {SUPPORT_PHONE} · {SUPPORT_EMAIL}
          </p>
          <p className="text-muted-foreground">
            We will post changes to this policy on this page.
          </p>
        </Section>
      </section>
    </Shell>
  );
}

/** Public "delete my account" page (required by the app stores): what is deleted, and the button when signed in. */
export function DeleteAccountPage() {
  const { t } = useTranslation();
  const { status, me, signOut } = useAuth();
  const signedIn = status === "authenticated" && !!me;
  const expected = me?.user.email ?? me?.user.mobile ?? "";
  const personal = !!me && me.company.accountType !== "BUSINESS";
  const [typed, setTyped] = useState("");
  const del = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; scope: "account" | "user"; deletedRows: number }>(
        "/me/account/delete",
        { confirm: typed },
      ),
    onSuccess: () => {
      toast.success(t("Your account was deleted."));
      signOut();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Shell title={t("Delete your VeeTrax account")}>
      <p className="text-muted-foreground">
        {t("For the VeeTrax and VeeTrax Tracker apps by {{company}}.", {
          company: COMPANY,
        })}
      </p>
      <Section title={t("What is deleted")}>
        <ul className="list-disc space-y-1 ps-5">
          <li>
            <b>{t("Personal or family account:")}</b>{" "}
            {t(
              "the whole account: your login, every phone, tracker and dashcam in it, and all their locations, history, trips, alerts and settings.",
            )}
          </li>
          <li>
            <b>{t("User of a company account:")}</b>{" "}
            {t(
              "your login and personal settings. The company’s vehicles and data belong to the company; ask your administrator about them.",
            )}
          </li>
          <li>
            <b>{t("VeeTrax Tracker app:")}</b>{" "}
            {t(
              "the phone belongs to the VeeTrax account of the e-mail or mobile number used to activate it. Sign in below with that e-mail, or with an OTP on that mobile number, to delete the account with the phone and its location history. To only stop sharing, tap Sign out / deactivate in the Tracker.",
            )}
          </li>
          <li>
            {t(
              "Deletion is immediate and cannot be undone. Encrypted backups are removed automatically within 100 days. Invoices are kept as long as tax law requires.",
            )}
          </li>
        </ul>
      </Section>
      <Section title={t("Delete now")}>
        {signedIn ? (
          <div className="space-y-3">
            <p>
              {personal
                ? t("This deletes the account {{name}} and everything in it.", {
                    name: me.company.name,
                  })
                : t("This deletes your login {{name}}.", {
                    name: expected,
                  })}{" "}
              {t("Type {{text}} to confirm.", { text: expected })}
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={expected}
              aria-label={t("Confirmation")}
              autoComplete="off"
            />
            <Button
              variant="destructive"
              disabled={
                del.isPending ||
                typed.trim().toLowerCase() !== expected.toLowerCase()
              }
              onClick={() => del.mutate()}
            >
              {del.isPending ? <Spinner /> : <Trash2Icon />}{" "}
              {t("Delete my account")}
            </Button>
          </div>
        ) : (
          <p>
            <Link className="font-medium text-primary underline" to="/login">
              {t("Sign in")}
            </Link>{" "}
            {t(
              "first, then come back to this page. Can’t sign in? Call {{phone}} or e-mail {{email}} from your registered address and we will delete it for you.",
              { phone: SUPPORT_PHONE, email: SUPPORT_EMAIL },
            )}
          </p>
        )}
      </Section>
    </Shell>
  );
}
