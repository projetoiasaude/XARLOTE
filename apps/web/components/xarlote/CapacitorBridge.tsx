'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { registerPush } from '@/lib/xarlote/api';

/**
 * Ponte entre o app web e a casca nativa (Capacitor). Só faz algo quando rodando
 * DENTRO do app nativo iOS/Android — no navegador comum é inerte (a checagem
 * `isNativePlatform` retorna false e nada é registrado).
 *
 * Responsabilidades:
 *  - Pedir permissão e registrar o token de push (FCM/APNs) → backend.
 *  - Abrir o app na rota certa quando o usuário toca numa notificação.
 *  - Ajustar a status bar pro tema escuro + botão voltar do Android.
 *
 * Os plugins são importados DINAMICAMENTE dentro do efeito pra não pesarem (nem
 * quebrarem o SSR/build) no bundle web.
 */
export function CapacitorBridge() {
  const { phone } = useXarloteApp();
  const router = useRouter();

  const phoneRef = useRef<string | null>(phone);
  const pendingToken = useRef<string | null>(null); // token chegou antes do pareamento
  const registeredFor = useRef<string | null>(null);

  // Monta a ponte nativa uma única vez.
  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return;
      const platform = Capacitor.getPlatform() as 'ios' | 'android' | 'web';

      // Status bar escura (combina com o fundo navy do app)
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
      } catch {
        /* plugin ausente — ignora */
      }

      // ── Push ────────────────────────────────────────────────────────────────
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');

        const regListener = await PushNotifications.addListener('registration', (t) => {
          if (disposed) return;
          try {
            window.localStorage.setItem('xarlote.push.token', t.value); // pra dar baixa no logout
          } catch {
            /* ignore */
          }
          const ph = phoneRef.current;
          if (ph) {
            void registerPush(ph, t.value, platform);
            registeredFor.current = ph;
          } else {
            pendingToken.current = t.value; // registra quando o usuário parear
          }
        });
        cleanups.push(() => void regListener.remove());

        // tocou na notificação → abre a rota do payload
        const tapListener = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          (action) => {
            const route = (action.notification.data as { route?: string } | undefined)?.route;
            if (route) router.push(route);
          },
        );
        cleanups.push(() => void tapListener.remove());

        const perm = await PushNotifications.checkPermissions();
        let granted = perm.receive === 'granted';
        if (perm.receive === 'prompt') {
          const req = await PushNotifications.requestPermissions();
          granted = req.receive === 'granted';
        }
        if (granted) await PushNotifications.register();
      } catch {
        /* push indisponível — app segue funcionando normalmente */
      }

      // ── Botão voltar do Android ──────────────────────────────────────────────
      try {
        const { App } = await import('@capacitor/app');
        const backListener = await App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) window.history.back();
          else void App.exitApp();
        });
        cleanups.push(() => void backListener.remove());
      } catch {
        /* ignore */
      }
    })();

    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Telefone mudou: mantém o ref atual e registra um token que chegou antes do login.
  useEffect(() => {
    phoneRef.current = phone;
    if (phone && pendingToken.current && registeredFor.current !== phone) {
      void (async () => {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const platform = Capacitor.getPlatform() as 'ios' | 'android' | 'web';
        await registerPush(phone, pendingToken.current!, platform);
        registeredFor.current = phone;
        pendingToken.current = null;
      })();
    }
  }, [phone]);

  return null;
}
