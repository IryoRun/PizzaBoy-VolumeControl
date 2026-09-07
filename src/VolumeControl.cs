// PizzaBoy VolumeControl -- the native window. A plain WinForms app (no
// browser engine, no PowerShell) that starts the Node backend
// (volume-tool.js) hidden, waits for its local HTTP API to come up, then
// shows two sliders -- Music and Game Sounds -- that call that API. Closing
// the window stops the backend too.
//
// Built once on first launch by "PizzaBoy VolumeControl.bat" using the C#
// compiler that ships with the .NET Framework already on Windows -- no
// PowerShell execution-policy bypass, no extra download, just Microsoft's
// own compiler turning readable source into a real .exe.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace PizzaBoyVolumeControl
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal sealed class MainForm : Form
    {
        private const string ApiBase = "http://127.0.0.1:9333";

        private readonly string _root;
        private Process _backend;
        private System.Windows.Forms.Timer _sendTimer;
        private TrackBar _pending;

        private Label _status;

        public MainForm()
        {
            // This exe lives in src\, so its parent is the project root.
            _root = Path.GetDirectoryName(Path.GetDirectoryName(Application.ExecutablePath));

            Text = "PizzaBoy VolumeControl";
            ClientSize = new Size(300, 190);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(27, 16, 35);
            Font = new Font("Segoe UI", 9f);

            var initial = ReadInitialState();
            AddVolumeRow("music", "Music", 18, initial.Music);
            AddVolumeRow("sfx", "Game Sounds", 90, initial.Sfx);

            _status = new Label
            {
                Text = "",
                ForeColor = Color.FromArgb(156, 134, 173),
                Font = new Font("Segoe UI", 8f),
                Location = new Point(16, 160),
                AutoSize = true,
            };
            Controls.Add(_status);

            _sendTimer = new System.Windows.Forms.Timer { Interval = 150 };
            _sendTimer.Tick += SendTimer_Tick;

            Load += MainForm_Load;
            FormClosing += MainForm_FormClosing;
        }

        private struct VolumeState
        {
            public int Music;
            public int Sfx;
        }

        private VolumeState ReadInitialState()
        {
            var state = new VolumeState { Music = 100, Sfx = 100 };
            try
            {
                string path = Path.Combine(_root, "states", "audio-volume.json");
                string json = File.ReadAllText(path);
                var music = Regex.Match(json, "\"music\"\\s*:\\s*([0-9.]+)");
                var sfx = Regex.Match(json, "\"sfx\"\\s*:\\s*([0-9.]+)");
                if (music.Success) state.Music = ClampPercent(double.Parse(music.Groups[1].Value) * 100);
                if (sfx.Success) state.Sfx = ClampPercent(double.Parse(sfx.Groups[1].Value) * 100);
            }
            catch
            {
                // First run, or no saved state yet -- defaults above stand.
            }
            return state;
        }

        private static int ClampPercent(double v)
        {
            int i = (int)Math.Round(v);
            if (i < 0) return 0;
            if (i > 100) return 100;
            return i;
        }

        private sealed class RowInfo
        {
            public string Channel;
            public Label ValueLabel;
        }

        private void AddVolumeRow(string channel, string labelText, int y, int initialValue)
        {
            var label = new Label
            {
                Text = labelText,
                ForeColor = Color.FromArgb(201, 182, 220),
                Location = new Point(16, y),
                AutoSize = true,
            };
            Controls.Add(label);

            var valueLabel = new Label
            {
                Text = initialValue + "%",
                ForeColor = Color.FromArgb(244, 233, 255),
                Location = new Point(240, y),
                AutoSize = true,
                TextAlign = ContentAlignment.MiddleRight,
            };
            Controls.Add(valueLabel);

            var track = new TrackBar
            {
                Minimum = 0,
                Maximum = 100,
                TickStyle = TickStyle.None,
                Value = initialValue,
                Location = new Point(12, y + 20),
                Width = 276,
                Tag = new RowInfo { Channel = channel, ValueLabel = valueLabel },
            };
            track.ValueChanged += Track_ValueChanged;
            Controls.Add(track);
        }

        private void Track_ValueChanged(object sender, EventArgs e)
        {
            var track = (TrackBar)sender;
            var info = (RowInfo)track.Tag;
            info.ValueLabel.Text = track.Value + "%";

            // Fires once during construction too (setting Value in the
            // initializer), before the backend is even started -- that
            // first queued send just fails silently and is harmless, since
            // the very next real change replaces it.
            _pending = track;
            _sendTimer.Stop();
            _sendTimer.Start();
        }

        private void SendTimer_Tick(object sender, EventArgs e)
        {
            _sendTimer.Stop();
            if (_pending == null) return;
            var track = _pending;
            _pending = null;

            var info = (RowInfo)track.Tag;
            string channel = info.Channel;
            double v = track.Value / 100.0;
            try
            {
                string url = string.Format("{0}/set?channel={1}&v={2}", ApiBase, channel,
                    v.ToString(System.Globalization.CultureInfo.InvariantCulture));
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 3000;
                using (req.GetResponse()) { }
                _status.Text = "";
            }
            catch
            {
                _status.Text = "Lost connection to the game";
            }
        }

        private void MainForm_Load(object sender, EventArgs e)
        {
            Hide(); // stay off-screen until the backend is confirmed ready

            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "\"src\\volume-tool.js\"",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            try
            {
                _backend = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "PizzaBoy VolumeControl could not start Node.js.\n\n" + ex.Message,
                    "PizzaBoy VolumeControl", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            bool ready = false;
            DateTime deadline = DateTime.Now.AddSeconds(45);
            while (DateTime.Now < deadline)
            {
                if (_backend.HasExited) break;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(ApiBase + "/ping");
                    req.Timeout = 2000;
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    {
                        if (resp.StatusCode == HttpStatusCode.OK) { ready = true; break; }
                    }
                }
                catch
                {
                    System.Threading.Thread.Sleep(400);
                }
            }

            if (!ready)
            {
                string msg = _backend.HasExited
                    ? "PizzaBoy VolumeControl could not start.\n\nThe backend process exited before it was ready. Run \"npm run volume\" from a terminal to see the full error."
                    : "PizzaBoy VolumeControl could not reach the game.\n\nMake sure PizzaBoy is installed, then try again.";
                MessageBox.Show(msg, "PizzaBoy VolumeControl", MessageBoxButtons.OK, MessageBoxIcon.Error);
                KillBackend();
                Close();
                return;
            }

            Show();
        }

        private void MainForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            KillBackend();
        }

        private void KillBackend()
        {
            try
            {
                if (_backend != null && !_backend.HasExited) _backend.Kill();
            }
            catch { /* already gone */ }
        }
    }
}
