/**
 * Hindi and Tamil text of the WP 3.9 BOOKING_CREATED passenger notification (D-A4; generic push / inbox text built by
 * transportNotificationText on the server). Own file so parallel web / mobile work on the other tables does not
 * conflict; index.ts merges it and any other table wins for a key they share.
 */
export const TRANSPORT_ADHOC_NOTIFY_HI: Record<string, string> = {
  'Ride booked for you': 'आपके लिए राइड बुक की गई',
  'The transport desk booked a ride for you. Open the app for details.': 'ट्रांसपोर्ट डेस्क ने आपके लिए राइड बुक की है। विवरण के लिए ऐप खोलें।',
  // WP 3.9 wave 2 (D-A5)
  'Ride request approved': 'राइड अनुरोध स्वीकृत',
  'Your ride request was approved. Open the app for details.': 'आपका राइड अनुरोध स्वीकृत हो गया है। विवरण के लिए ऐप खोलें।',
  'Ride request not approved': 'राइड अनुरोध स्वीकृत नहीं हुआ',
  'Your ride request was not approved. Open the app for the reason.': 'आपका राइड अनुरोध स्वीकृत नहीं हुआ। कारण जानने के लिए ऐप खोलें।',
};

export const TRANSPORT_ADHOC_NOTIFY_TA: Record<string, string> = {
  'Ride booked for you': 'உங்களுக்காக பயணம் முன்பதிவு செய்யப்பட்டது',
  'The transport desk booked a ride for you. Open the app for details.': 'போக்குவரத்து மேசை உங்களுக்காக ஒரு பயணத்தை முன்பதிவு செய்துள்ளது. விவரங்களுக்கு செயலியைத் திறக்கவும்.',
  // WP 3.9 wave 2 (D-A5)
  'Ride request approved': 'பயணக் கோரிக்கை அங்கீகரிக்கப்பட்டது',
  'Your ride request was approved. Open the app for details.': 'உங்கள் பயணக் கோரிக்கை அங்கீகரிக்கப்பட்டது. விவரங்களுக்கு செயலியைத் திறக்கவும்.',
  'Ride request not approved': 'பயணக் கோரிக்கை அங்கீகரிக்கப்படவில்லை',
  'Your ride request was not approved. Open the app for the reason.': 'உங்கள் பயணக் கோரிக்கை அங்கீகரிக்கப்படவில்லை. காரணத்தை அறிய செயலியைத் திறக்கவும்.',
};
