// Differential-fuzzing shim: runs qledger-v1 cases through the Java RDK.
// stdin: one JSON case per line (the generators' compact form); stdout: one JSON result per line.
import io.github.qorechain.rdk.qledger.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;

public class Shim {
    static final Pattern STR = Pattern.compile("\"(id|chainId|rollupId)\":\"([^\"]*)\"");
    static final Pattern ENTRIES = Pattern.compile("\"entries\":\\[(.*?)\\]\\}");
    static final Pattern ENTRY = Pattern.compile("\\{\"height\":(\\d+),\"poster\":\"((?:[^\"\\\\]|\\\\.)*)\",\"payload\":\"([0-9a-f]*)\"\\}");
    static byte[] hex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }
    static String hex(byte[] b) {
        if (b == null) return "";
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
    static String q(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    static String unesc(String s) { return s.replace("\\\"", "\"").replace("\\\\", "\\"); }

    public static void main(String[] a) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8), 1 << 20);
        PrintStream out = new PrintStream(new BufferedOutputStream(System.out, 1 << 20), false, "UTF-8");
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            Map<String, String> f = new HashMap<>();
            Matcher m = STR.matcher(line);
            while (m.find()) f.putIfAbsent(m.group(1), m.group(2));
            StringBuilder res = new StringBuilder("{\"id\":" + q(f.get("id")) + ",\"batches\":[");
            QledgerLedger ledger = new QledgerLedger();
            Matcher eb = ENTRIES.matcher(line);
            boolean firstB = true;
            while (eb.find()) {
                List<QledgerEntry> entries = new ArrayList<>();
                Matcher e = ENTRY.matcher(eb.group(1));
                while (e.find()) entries.add(new QledgerEntry(Long.parseUnsignedLong(e.group(1)), unesc(e.group(2)), hex(e.group(3))));
                if (!firstB) res.append(',');
                firstB = false;
                try {
                    QledgerResult r = QledgerExec.execute(f.get("chainId"), f.get("rollupId"), ledger, entries);
                    res.append("{\"stateRoot\":").append(q(hex(r.stateRoot))).append(",\"withdrawalsRoot\":").append(q(hex(r.withdrawalsRoot))).append(",\"withdrawals\":[");
                    for (int i = 0; i < r.withdrawals.size(); i++) {
                        QledgerWithdrawal w = r.withdrawals.get(i);
                        if (i > 0) res.append(',');
                        res.append("{\"index\":").append(q(Long.toUnsignedString(w.index))).append(",\"recipient\":").append(q(w.recipient)).append(",\"amount\":").append(q(Long.toUnsignedString(w.amount))).append('}');
                    }
                    res.append("]}");
                } catch (Exception ex) {
                    res.append("{\"withdrawalsRoot\":\"\",\"withdrawals\":[],\"error\":").append(q(ex.getClass().getSimpleName())).append('}');
                }
            }
            res.append("]}");
            out.println(res);
        }
        out.flush();
    }
}
