while true; do
    for i in {1..50}; do
      curl -s app.eks.kosmiha.eu > /dev/null &
    done
    echo "Sending 50 requests"
    sleep 0.1
  done