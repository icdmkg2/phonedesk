package com.phonedesk.display;

import android.content.Context;
import android.net.wifi.WifiManager;

import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;

/** A tiny multicast-DNS lookup, so "phonedesk.local" works even where Android's own resolver can't do .local. */
final class Mdns {
    private Mdns() {}

    static String resolve(Context ctx, String host) {
        WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = null;
        MulticastSocket s = null;
        try {
            if (wm != null) { lock = wm.createMulticastLock("phonedesk"); lock.setReferenceCounted(false); lock.acquire(); }
            s = new MulticastSocket(null);
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(0)); // not 5353: replies come straight back to us
            s.setSoTimeout(900);
            byte[] q = query(host);
            InetAddress group = InetAddress.getByName("224.0.0.251");
            for (int attempt = 0; attempt < 3; attempt++) {
                s.send(new DatagramPacket(q, q.length, group, 5353));
                long end = System.currentTimeMillis() + 900;
                while (System.currentTimeMillis() < end) {
                    try {
                        byte[] buf = new byte[1500];
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        s.receive(p);
                        String ip = parse(buf, p.getLength());
                        if (ip != null) return ip;
                    } catch (java.net.SocketTimeoutException e) { break; }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (s != null) try { s.close(); } catch (Exception ignored) {}
            if (lock != null && lock.isHeld()) lock.release();
        }
        return null;
    }

    private static byte[] query(String host) {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        o.write(0); o.write(0);        // id
        o.write(0); o.write(0);        // flags: standard query
        o.write(0); o.write(1);        // 1 question
        o.write(0); o.write(0); o.write(0); o.write(0); o.write(0); o.write(0);
        for (String label : host.split("\\.")) {
            byte[] b = label.getBytes();
            o.write(b.length);
            o.write(b, 0, b.length);
        }
        o.write(0);
        o.write(0); o.write(1);        // type A
        o.write(0); o.write(1);        // class IN
        return o.toByteArray();
    }

    private static int skipName(byte[] d, int i) {
        while (i < d.length) {
            int l = d[i] & 0xff;
            if (l == 0) return i + 1;
            if ((l & 0xc0) == 0xc0) return i + 2;
            i += l + 1;
        }
        return d.length;
    }

    private static String parse(byte[] d, int len) {
        if (len < 12) return null;
        int qd = ((d[4] & 0xff) << 8) | (d[5] & 0xff);
        int an = ((d[6] & 0xff) << 8) | (d[7] & 0xff);
        int i = 12;
        for (int k = 0; k < qd; k++) i = skipName(d, i) + 4;
        for (int k = 0; k < an && i < len; k++) {
            i = skipName(d, i);
            if (i + 10 > len) return null;
            int type = ((d[i] & 0xff) << 8) | (d[i + 1] & 0xff);
            int rdlen = ((d[i + 8] & 0xff) << 8) | (d[i + 9] & 0xff);
            i += 10;
            if (type == 1 && rdlen == 4 && i + 4 <= len) {
                return (d[i] & 0xff) + "." + (d[i + 1] & 0xff) + "." + (d[i + 2] & 0xff) + "." + (d[i + 3] & 0xff);
            }
            i += rdlen;
        }
        return null;
    }
}
