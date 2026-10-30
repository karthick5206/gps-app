import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Space to leave under a bottom-pinned bar (chat input etc.): the open keyboard, else the
 * system navigation / gesture bar. Edge-to-edge Android (15+) no longer resizes the window for
 * the keyboard, so KeyboardAvoidingView alone leaves the bar hidden behind it.
 */
export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Android reports the keyboard height without the navigation bar under it; iOS includes the home indicator.
  if (!keyboard) return insets.bottom;
  return Platform.OS === 'android' ? keyboard + insets.bottom : Math.max(keyboard, insets.bottom);
}
