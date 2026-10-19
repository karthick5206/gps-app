import type { CheckoutDto } from '@veetracer/shared';

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (r: { error?: { description?: string } }) => void): void;
}

type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

let loading: Promise<RazorpayCtor> | null = null;

function loadCheckout(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => {
      const ctor = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (ctor) resolve(ctor);
      else reject(new Error('Razorpay checkout did not load'));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load Razorpay checkout. Check your connection and try again.'));
    };
    document.body.appendChild(s);
  });
  return loading;
}

/**
 * Opens Razorpay Checkout for a server-created order. Resolves with the payment response (verified by the server
 * afterwards — the browser result alone never activates anything), or null when the buyer closes the window.
 */
export async function openCheckout(order: CheckoutDto, themeColor = '#0e5e57'): Promise<RazorpayResponse | null> {
  const Razorpay = await loadCheckout();
  return new Promise((resolve, reject) => {
    const rz = new Razorpay({
      key: order.keyId,
      amount: order.amountPaise,
      currency: order.currency,
      name: order.name,
      description: order.description,
      order_id: order.razorpayOrderId,
      prefill: order.prefill,
      theme: { color: themeColor },
      handler: (r: RazorpayResponse) => resolve(r),
      modal: { ondismiss: () => resolve(null) },
    });
    rz.on('payment.failed', (r) => reject(new Error(r.error?.description ?? 'Payment failed')));
    rz.open();
  });
}
