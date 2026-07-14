// Web Push subscription helper — call subscribeToPush() after login to enable notifications
(function() {
  'use strict';

  // Check if push is supported and user granted permission
  async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log('[web-push] not supported in this browser');
      return false;
    }

    try {
      // Wait for service worker to be ready
      const registration = await navigator.serviceWorker.ready;

      // Check current permission
      let permission = Notification.permission;
      if (permission === 'denied') {
        console.log('[web-push] permission denied');
        return false;
      }

      // Request permission if not yet granted
      if (permission !== 'granted') {
        permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          console.log('[web-push] permission not granted');
          return false;
        }
      }

      // Get VAPID public key from server
      const vapidResp = await fetch('/api/push/vapid-public-key');
      if (!vapidResp.ok) {
        console.log('[web-push] VAPID key fetch failed:', vapidResp.status);
        return false;
      }
      const { publicKey } = await vapidResp.json();

      // Check if already subscribed
      let subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        console.log('[web-push] already subscribed');
        // Re-send subscription to server to update last_used_at
        await sendSubscriptionToServer(subscription);
        return true;
      }

      // Subscribe for push
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

      console.log('[web-push] subscribed successfully');

      // Send subscription to server
      await sendSubscriptionToServer(subscription);
      return true;

    } catch (err) {
      console.error('[web-push] subscription failed:', err);
      return false;
    }
  }

  async function unsubscribeFromPush() {
    if (!('serviceWorker' in navigator)) return;

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;

      // Unsubscribe from browser
      await subscription.unsubscribe();

      // Notify server
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (localStorage.getItem('token') || '')
        },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      });

      console.log('[web-push] unsubscribed successfully');
    } catch (err) {
      console.error('[web-push] unsubscribe failed:', err);
    }
  }

  async function sendSubscriptionToServer(subscription) {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    if (!token) {
      console.log('[web-push] no auth token, skipping server sync');
      return;
    }

    const resp = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        subscription: {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(subscription.getKey('p256dh')),
            auth: arrayBufferToBase64(subscription.getKey('auth'))
          }
        },
        userAgent: navigator.userAgent
      })
    });

    if (!resp.ok) {
      console.error('[web-push] server subscribe failed:', resp.status);
    }
  }

  // Helper: convert VAPID public key to Uint8Array
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // Helper: convert ArrayBuffer to base64
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Export to global
  window.WrenPush = {
    subscribe: subscribeToPush,
    unsubscribe: unsubscribeFromPush
  };
})();
