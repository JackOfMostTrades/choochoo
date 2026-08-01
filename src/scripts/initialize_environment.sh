function read_variable() {
  name="$1"
  default="$2"

  read -p "Enter $1 [$default]: " result

  if [[ -z "$result" ]]; then
    result="$default"
  fi

  echo "export $name=$result" >> ~/.bash_profile
}


touch ~/.bash_profile

secret="$(read_variable "SESSION_SECRET" "foobar")"
database_url="$(read_variable "DATABASE_URL" "mariadb://choochoo:choochoo@localhost:3306/choochoo")"
environment="$(read_variable "NODE_ENV" "development")"
redis_url="$(read_variable "REDIS_URL" "redis://localhost:6379/")"
client_origin="$(read_variable "CLIENT_ORIGIN" "")"